import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job, Queue } from "bullmq"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { readTenantSweep } from "../../jobs/sweeps"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { WebhookRepository } from "../repositories/webhook.repository"
import { deliveryJob, WEBHOOK_DELIVER_QUEUE } from "./deliver-job"

/** A delivery this late is assumed to have lost its job. */
const GRACE_MS = 60_000
const BATCH = 500

/**
 * The safety net under the delivery jobs (ADR-0050): pending deliveries whose
 * attempt is overdue are queued again. A duplicate is harmless, because the
 * attempt claims the delivery before it sends.
 */
@Injectable()
export class WebhookSweepService {
  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly tenant: TenantContextService,
    @InjectQueue(WEBHOOK_DELIVER_QUEUE) private readonly queue: Queue,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** A delivery's job is named for its scheduled time, so re-queueing one still waiting adds nothing. */
  async requeue(): Promise<number> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const overdue = await this.webhooks.overdue(orgId, new Date(now.getTime() - GRACE_MS), BATCH)
    await this.queue.addBulk(overdue.map((d) => deliveryJob(orgId, d.id, d.nextAttemptAt ?? now, now)))
    return overdue.length
  }
}

@Processor("webhook-sweep", { autorun: false })
export class WebhookSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: WebhookSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:webhook-sweep", "re-queue overdue deliveries", () => this.service.requeue())
  }
}
