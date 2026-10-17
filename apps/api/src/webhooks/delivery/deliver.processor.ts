import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { type OnApplicationBootstrap } from "@nestjs/common"
import { DelayedError, type Job, type Queue, UnrecoverableError } from "bullmq"

import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { WebhookRepository } from "../repositories/webhook.repository"
import { deliverJobSchema, deliveryJob, WEBHOOK_DELIVER_QUEUE } from "./deliver-job"
import { type AttemptOutcome, WebhookDeliverer } from "./deliverer"
import { TenantLease } from "./tenant-lease"

/** Deliveries one tenant may have in flight at once, by plan (ADR-0050). */
export const IN_FLIGHT_CAP = { FREE: 2, PRO: 8 } as const
/** Longer than an attempt can take, so a lease outlives its attempt and never its worker. */
const LEASE_TTL_MS = 30_000

/**
 * An attempt, inside the tenant, within the tenant's in-flight cap. A tenant
 * at its cap does not wait in a worker slot: the job goes back to the delayed
 * set for a moment, spending no attempt, and the slot serves someone else.
 */
@Processor(WEBHOOK_DELIVER_QUEUE, { autorun: false, concurrency: 16 })
export class DeliverProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly deliverer: WebhookDeliverer,
    private readonly webhooks: WebhookRepository,
    private readonly lease: TenantLease,
    @InjectQueue(WEBHOOK_DELIVER_QUEUE) private readonly queue: Queue,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job, token?: string): Promise<AttemptOutcome["kind"]> {
    const parsed = deliverJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`delivery job ${String(job.id)} is unreadable or names no tenant`)
    const { orgId, deliveryId } = parsed.data
    const outcome = await runJob({ orgId }, "job:webhook-deliver", "one attempt at one delivery", async () => {
      const lease = await this.lease.acquire(orgId, IN_FLIGHT_CAP[await this.webhooks.plan(orgId)], LEASE_TTL_MS)
      if (lease === null) return null
      try {
        return await this.deliverer.attempt(orgId, deliveryId)
      } finally {
        await lease.release()
      }
    })
    if (outcome === null) {
      // At the cap: back to the delayed set, jittered so a tenant's queue does not return in lockstep.
      await job.moveToDelayed(Date.now() + 500 + Math.floor(Math.random() * 1_000), token)
      throw new DelayedError()
    }
    if (outcome.kind === "retry") await this.queue.add(...spread(deliveryJob(orgId, deliveryId, `a${String(outcome.attempt)}`, outcome.delayMs)))
    if (outcome.kind === "postponed") {
      const wait = Math.max(0, outcome.until.getTime() - Date.now())
      await this.queue.add(...spread(deliveryJob(orgId, deliveryId, `w${String(outcome.until.getTime())}`, wait)))
    }
    return outcome.kind
  }
}

function spread(job: ReturnType<typeof deliveryJob>): [string, ReturnType<typeof deliveryJob>["data"], ReturnType<typeof deliveryJob>["opts"]] {
  return [job.name, job.data, job.opts]
}
