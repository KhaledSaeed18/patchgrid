import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Queue } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { CredentialRetentionRepository } from "../platform/repositories/credential-retention.repository"

export const CREDENTIAL_RETENTION_QUEUE = "credential-retention"
/** Tokens are kept this long past their expiry (ADR-0028). */
export const CREDENTIAL_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60_000

/**
 * The one retention job with no tenant to run per (ADR-0044): the rows are
 * platform-class, like the audit partitions (ADR-0034), so it runs daily as
 * a platform job and can reach nothing tenant-owned.
 */
@Injectable()
export class CredentialRetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CredentialRetentionService.name)

  constructor(
    private readonly credentials: CredentialRetentionRepository,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() private readonly config: AppConfig,
    @InjectQueue(CREDENTIAL_RETENTION_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.WORKER_MODE !== "api") {
      await this.queue.upsertJobScheduler("daily", { pattern: "41 3 * * *", tz: "UTC" }, { data: { orgId: null } })
    }
  }

  async sweep(): Promise<{ refresh: number; reset: number; verification: number }> {
    const removed = await this.credentials.deleteExpiredBefore(new Date(this.clock.now().getTime() - CREDENTIAL_RETENTION_DAYS * DAY_MS))
    this.logger.log({ msg: "expired credentials removed", ...removed })
    return removed
  }
}

@Processor(CREDENTIAL_RETENTION_QUEUE, { autorun: false })
export class CredentialRetentionProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: CredentialRetentionService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(): Promise<{ refresh: number; reset: number; verification: number }> {
    return runJob({ orgId: null }, "job:credential-retention", "delete credentials 30 days past expiry", () => this.service.sweep())
  }
}
