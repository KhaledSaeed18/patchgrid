import { Processor, WorkerHost } from "@nestjs/bullmq"
import type { OnApplicationBootstrap } from "@nestjs/common"
import { idSchema } from "@patchgrid/contracts"
import { type Job, UnrecoverableError } from "bullmq"
import { z } from "zod"

import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { CONSUMER_NAMES } from "./consumer"
import { DrainRequests, OUTBOX_DRAIN_QUEUE } from "./drain-requests"
import { type DrainOutcome, EventRelay } from "./relay"

const drainJobSchema = z.object({ orgId: idSchema, consumer: z.enum(CONSUMER_NAMES) })

/** How soon a drain comes back when another holds the lock, or events wait above the horizon. */
export const RETRY_SOON_MS = 250

/**
 * One drain of one consumer in one tenant, inside that tenant (ADR-0049). It
 * clears the pending flag first, so a wake during the drain is not lost, then
 * reads a batch. What it found decides what follows: more to read goes to the
 * back of the queue; a held lock or a held horizon comes back shortly.
 */
@Processor(OUTBOX_DRAIN_QUEUE, { autorun: false, concurrency: 4 })
export class DrainProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly relay: EventRelay,
    private readonly requests: DrainRequests,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<DrainOutcome> {
    const parsed = drainJobSchema.safeParse(job.data)
    if (!parsed.success) {
      throw new UnrecoverableError(`drain job ${String(job.id)} is unreadable or names no tenant: ${parsed.error.message}`)
    }
    const { orgId, consumer } = parsed.data
    await this.requests.started(orgId, consumer)
    const outcome = await runJob({ orgId }, "job:outbox-drain", consumer, () => this.relay.drain(orgId, consumer))
    await this.follow(orgId, consumer, outcome)
    return outcome
  }

  private async follow(orgId: string, consumer: (typeof CONSUMER_NAMES)[number], outcome: DrainOutcome): Promise<void> {
    if (outcome.kind === "busy" || (outcome.kind === "idle" && outcome.heldBack)) {
      await this.requests.request(orgId, consumer, RETRY_SOON_MS)
    } else if (outcome.kind === "backoff") {
      await this.requests.request(orgId, consumer, Math.max(RETRY_SOON_MS, outcome.until.getTime() - Date.now()))
    } else if (outcome.kind === "drained" && outcome.more) {
      await this.requests.request(orgId, consumer)
    }
  }
}
