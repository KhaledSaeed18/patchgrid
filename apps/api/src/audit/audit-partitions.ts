import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Queue } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { AuditLogRepository } from "./repositories/audit-log.repository"

export const AUDIT_PARTITION_QUEUE = "audit-partition"

/** The month after `now`'s, by calendar rather than by 30 days. */
export function nextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

/**
 * Keeps a month of audit partitions ahead (ADR-0034). At boot, in every mode,
 * because a process that cannot write audit rows cannot change anything; then
 * daily from the `audit-partition` scheduler in worker modes, so a long-lived
 * process crosses a month boundary with next month already there.
 */
@Injectable()
export class AuditPartitionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditPartitionService.name)

  constructor(
    private readonly repository: AuditLogRepository,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() private readonly config: AppConfig,
    @InjectQueue(AUDIT_PARTITION_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureAhead()
    if (this.config.WORKER_MODE !== "api") {
      await this.queue.upsertJobScheduler("daily", { pattern: "17 3 * * *", tz: "UTC" }, { data: { orgId: null } })
    }
  }

  async ensureAhead(): Promise<string[]> {
    const now = this.clock.now()
    const names = [await this.repository.ensurePartition(now), await this.repository.ensurePartition(nextMonth(now))]
    this.logger.log({ msg: "audit partitions ensured", partitions: names })
    return names
  }
}

@Processor(AUDIT_PARTITION_QUEUE, { autorun: false })
export class AuditPartitionProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly partitions: AuditPartitionService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(): Promise<void> {
    await runJob({ orgId: null }, "job:audit-partition", "keep a month of audit partitions ahead", () =>
      this.partitions.ensureAhead(),
    )
  }
}
