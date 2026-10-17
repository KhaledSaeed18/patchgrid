import { InjectQueue } from "@nestjs/bullmq"
import { Injectable, Logger } from "@nestjs/common"
import type { Queue } from "bullmq"
import { v7 as uuidv7 } from "uuid"

import { jobId } from "../jobs/job-id"
import { RedisService } from "../redis/redis.service"
import type { ConsumerName } from "./consumer"

export const OUTBOX_DRAIN_QUEUE = "outbox-drain"

/** How long a pending flag may outlive a drain job that never ran. */
const PENDING_TTL_MS = 60_000

export const pendingKey = (orgId: string, consumer: ConsumerName) => `outbox:pending:${orgId}:${consumer}`

/**
 * Asks for a drain of one consumer in one tenant (ADR-0049), keeping **at most
 * one waiting drain** per pair: a flag set with `NX` decides who enqueues, and
 * the drain clears it when it *starts*. A request that arrives mid-drain
 * therefore enqueues the next one, which starts after it and so sees what woke
 * it. BullMQ's own deduplication would hold the id until the job completes and
 * drop exactly that request.
 *
 * One waiting drain per tenant is also what makes the queue fair: a tenant
 * with a flood has one place in line, like everyone else, and a drain that
 * yields goes to the back.
 */
@Injectable()
export class DrainRequests {
  private readonly logger = new Logger(DrainRequests.name)

  constructor(
    private readonly redis: RedisService,
    @InjectQueue(OUTBOX_DRAIN_QUEUE) private readonly queue: Queue,
  ) {}

  /** Never throws: a lost request costs latency until the sweep, never an event. */
  async request(orgId: string, consumer: ConsumerName, delayMs = 0): Promise<boolean> {
    const key = pendingKey(orgId, consumer)
    try {
      if ((await this.redis.client.set(key, "1", "PX", PENDING_TTL_MS + delayMs, "NX")) !== "OK") return false
      try {
        await this.queue.add(
          "drain",
          { orgId, consumer },
          { jobId: jobId(OUTBOX_DRAIN_QUEUE, orgId, consumer, uuidv7()), ...(delayMs > 0 ? { delay: delayMs } : {}) },
        )
      } catch (error) {
        await this.redis.client.del(key)
        throw error
      }
      return true
    } catch (error) {
      this.logger.warn({ msg: "drain not requested", orgId, consumer, error: String(error) })
      return false
    }
  }

  /** The drain is starting: whatever asks from now on gets a drain of its own. */
  async started(orgId: string, consumer: ConsumerName): Promise<void> {
    await this.redis.client.del(pendingKey(orgId, consumer))
  }
}
