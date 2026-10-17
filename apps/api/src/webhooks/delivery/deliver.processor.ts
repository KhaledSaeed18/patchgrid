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

/** How long a tenant's plan is trusted before it is read again. */
const PLAN_TTL_MS = 60_000
/** The longest a job at its tenant's cap waits before looking again. */
const MAX_CAP_WAIT_MS = 30_000

/**
 * An attempt, within the tenant's in-flight cap. The lease is taken before
 * anything touches the database (the plan is cached), so a tenant at its cap
 * costs a Redis call, not a transaction. A job that finds no room goes back to
 * the delayed set without spending an attempt, waiting longer each time it is
 * turned away (0.5 s doubling to 30 s, jittered), so a tenant's backlog does
 * not circle through the workers while its slow endpoint holds the slots.
 */
@Processor(WEBHOOK_DELIVER_QUEUE, { autorun: false, concurrency: 16 })
export class DeliverProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly plans = new Map<string, { plan: "FREE" | "PRO"; until: number }>()

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
    const { orgId, deliveryId, turnedAway } = parsed.data
    const lease = await this.lease.acquire(orgId, IN_FLIGHT_CAP[await this.plan(orgId)], LEASE_TTL_MS)
    if (lease === null) {
      const wait = Math.min(MAX_CAP_WAIT_MS, 500 * 2 ** turnedAway) * (0.5 + Math.random())
      await job.updateData({ orgId, deliveryId, turnedAway: turnedAway + 1 })
      await job.moveToDelayed(Date.now() + Math.round(wait), token)
      throw new DelayedError()
    }
    let outcome: AttemptOutcome
    try {
      outcome = await runJob({ orgId }, "job:webhook-deliver", "one attempt at one delivery", () => this.deliverer.attempt(orgId, deliveryId))
    } finally {
      await lease.release()
    }
    const now = new Date()
    if (outcome.kind === "retry") await this.queue.add(...spread(deliveryJob(orgId, deliveryId, outcome.at, now)))
    if (outcome.kind === "postponed") await this.queue.add(...spread(deliveryJob(orgId, deliveryId, outcome.until, now)))
    return outcome.kind
  }

  private async plan(orgId: string): Promise<"FREE" | "PRO"> {
    const cached = this.plans.get(orgId)
    if (cached !== undefined && cached.until > Date.now()) return cached.plan
    const plan = await runJob({ orgId }, "job:webhook-deliver", "read the tenant's plan for its cap", () => this.webhooks.plan(orgId))
    this.plans.set(orgId, { plan, until: Date.now() + PLAN_TTL_MS })
    return plan
  }
}

function spread(job: ReturnType<typeof deliveryJob>): [string, ReturnType<typeof deliveryJob>["data"], ReturnType<typeof deliveryJob>["opts"]] {
  return [job.name, job.data, job.opts]
}
