import { Injectable, Logger } from "@nestjs/common"

import { type Clock, InjectClock } from "../common/clock/clock"
import { PrismaService } from "../prisma/prisma.service"
import { recordOutboxConsumed, recordOutboxDrain, recordOutboxParked } from "../telemetry/metrics"
import { type AfterCommit, type ConsumerName, EventConsumers } from "./consumer"
import { OutboxRepository, type StoredEvent } from "./repositories/outbox.repository"

/** Events one drain takes before it yields to the next tenant (ADR-0049, fairness). */
export const DRAIN_BATCH = 100
/** Failures of one event before it is parked and the consumer moves on. */
export const OUTBOX_MAX_FAILURES = 3
/**
 * How long a consumer waits after the `n`th failure of an event before trying
 * it again: 2 s, 8 s, 32 s. The wait lives on the cursor, not on a job, so a
 * wake or a sweep in between does not retry early and burn the count.
 */
export function failureBackoffMs(failures: number): number {
  return 2_000 * 4 ** Math.max(0, failures - 1)
}

/**
 * Failures that say nothing about the event: a deadlock, a serialization
 * conflict, an interactive transaction that timed out under load, a dropped
 * connection. They are retried as the job's own failure and never counted
 * against the event, or a busy minute would park good events.
 */
const TRANSIENT = new Set(["40P01", "40001", "55P03", "57014", "08006", "P2028", "P2034", "P1001", "P1017"])
export function isTransient(error: unknown, depth = 0): boolean {
  if (error instanceof TransientFailure) return true
  if (typeof error !== "object" || error === null || depth > 4) return false
  const record = error as Record<string, unknown>
  if (typeof record.code === "string" && TRANSIENT.has(record.code)) return true
  return ["cause", "meta", "driverAdapterError", "originalError"].some((key) => isTransient(record[key], depth + 1))
}

/**
 * A consumer's own way of saying "not the event's fault": a dependency
 * refused for a moment (Redis turning away a mail job). Retried as the job's
 * failure, never counted against the event, so it cannot park a good one.
 */
export class TransientFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "TransientFailure"
  }
}

/**
 * What a drain did, and so what should happen next:
 * - `busy`: another drain holds this consumer's lock; come back shortly.
 * - `idle`: nothing to read. `heldBack` when committed events wait above the
 *   snapshot horizon, so come back shortly rather than at the next wake.
 * - `drained`: handled `count` events; `more` when the batch was full or events
 *   were held back, so the drain goes to the back of the queue and continues.
 */
export type DrainOutcome =
  | { kind: "busy" }
  | { kind: "idle"; heldBack: boolean }
  | { kind: "backoff"; until: Date }
  | { kind: "drained"; count: number; parked: number; more: boolean }

type Step =
  | { kind: "busy" }
  | { kind: "idle"; heldBack: boolean }
  | { kind: "backoff"; until: Date }
  | { kind: "parked"; event: StoredEvent }
  | { kind: "handled"; count: number; full: boolean; heldBack: boolean; after: AfterCommit; occurredAt: Date[] }

/** A batch that failed somewhere, and the one event to blame when it was a batch of one. */
class StepFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly single: StoredEvent | null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

/** Thrown once a failing event has been recorded, so the job backs off before the next try. */
export class ConsumerEventFailed extends Error {
  constructor(consumer: string, eventId: string, failures: number, message: string) {
    super(`consumer ${consumer} failed event ${eventId} (${String(failures)}/${String(OUTBOX_MAX_FAILURES)}): ${message}`)
  }
}

/**
 * Reads one consumer's place in one tenant's log forward (ADR-0049). Runs
 * inside the tenant (the drain job's `runJob`). Each step is one transaction:
 * the advisory lock, the cursor, the read below the horizon, the handler's
 * writes and the new cursor commit together, and the handler's after-commit
 * work follows.
 *
 * A batch that throws is retried one event per transaction until the event
 * that fails is found; its failure is recorded and the drain throws, so the job
 * backs off. An event that has failed `OUTBOX_MAX_FAILURES` times is parked in
 * the dead letters and the cursor moves past it.
 */
@Injectable()
export class EventRelay {
  private readonly logger = new Logger(EventRelay.name)

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly consumers: EventConsumers,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async drain(orgId: string, name: ConsumerName, batch = DRAIN_BATCH): Promise<DrainOutcome> {
    const outcome = await this.drainSteps(orgId, name, batch)
    recordOutboxDrain(
      name,
      outcome.kind === "idle" ? (outcome.heldBack ? "held-back" : "idle") : outcome.kind === "backoff" ? "busy" : outcome.kind,
    )
    return outcome
  }

  private async drainSteps(orgId: string, name: ConsumerName, batch: number): Promise<DrainOutcome> {
    let count = 0
    let parked = 0
    // A batch that failed is retried event by event, up to its own size, then the drain yields.
    let single = false
    let budget = batch
    for (;;) {
      let step: Step
      try {
        step = await this.step(orgId, name, single ? 1 : batch)
      } catch (error) {
        if (!(error instanceof StepFailed)) throw error
        // The database's trouble, not the event's: the job retries, the event is not blamed.
        if (isTransient(error.cause)) throw error.cause
        const failed = error.single
        if (failed === null) {
          single = true
          continue
        }
        const message = error.message.slice(0, 2_000)
        const failures = await this.prisma.transaction(() => this.outbox.recordFailure(orgId, name, failed, message))
        throw new ConsumerEventFailed(name, failed.id, failures ?? 0, message)
      }

      if (step.kind === "busy") return count === 0 && parked === 0 ? step : { kind: "drained", count, parked, more: true }
      if (step.kind === "backoff") return count === 0 && parked === 0 ? step : { kind: "drained", count, parked, more: true }
      if (step.kind === "idle") {
        return count === 0 && parked === 0 ? step : { kind: "drained", count, parked, more: step.heldBack }
      }
      if (step.kind === "parked") {
        parked += 1
        recordOutboxParked(name, orgId)
        this.logger.warn({ msg: "event parked", orgId, consumer: name, eventId: step.event.id, type: step.event.type })
        if (!single) return { kind: "drained", count, parked, more: true }
        budget -= 1
      } else {
        count += step.count
        const now = this.clock.now().getTime()
        recordOutboxConsumed({ consumer: name, orgId, ages: step.occurredAt.map((at) => now - at.getTime()) })
        await this.afterCommit(orgId, name, step.after)
        if (!single) return { kind: "drained", count, parked, more: step.full || step.heldBack }
        budget -= step.count
      }
      if (budget <= 0) return { kind: "drained", count, parked, more: true }
    }
  }

  private async step(orgId: string, name: ConsumerName, limit: number): Promise<Step> {
    const consumer = this.consumers.get(name)
    let read: readonly StoredEvent[] = []
    try {
      return await this.prisma.transaction(async (): Promise<Step> => {
        if (!(await this.outbox.tryLock(orgId, name))) return { kind: "busy" }
        const cursor = await this.outbox.cursor(orgId, name)
        // An event that failed waits out its backoff, whoever asked for this drain.
        if (cursor.failures > 0 && cursor.failedAt !== null) {
          const until = new Date(cursor.failedAt.getTime() + failureBackoffMs(cursor.failures))
          if (until > this.clock.now()) return { kind: "backoff", until }
        }
        // A consumer stuck on an event reads one at a time until it is past it.
        const take = cursor.failures > 0 ? 1 : limit
        const { events, heldBack } = await this.outbox.read(orgId, cursor, take)
        read = events
        const head = events[0]
        if (head === undefined) return { kind: "idle", heldBack }
        if (cursor.failures >= OUTBOX_MAX_FAILURES && head.id === cursor.failingEventId) {
          await this.outbox.park(orgId, name, head, cursor.failures, "gave up after repeated failures")
          return { kind: "parked", event: head }
        }
        const after = await consumer.handle(orgId, events)
        const last = events.at(-1) ?? head
        await this.outbox.advance(orgId, name, last)
        return {
          kind: "handled",
          count: events.length,
          full: events.length === take,
          heldBack,
          after,
          occurredAt: events.map((e) => e.occurredAt),
        }
      })
    } catch (error) {
      const only = read.length === 1 ? (read[0] ?? null) : null
      // Nothing was read: the failure is the relay's own, not an event's.
      if (read.length === 0) throw error
      throw new StepFailed(error, only)
    }
  }

  /**
   * Best effort, after the cursor committed: a failure here (Redis refusing an
   * email job) is logged and lost, and can never undo the rows that committed.
   */
  private async afterCommit(orgId: string, consumer: string, after: AfterCommit): Promise<void> {
    try {
      await after()
    } catch (error) {
      this.logger.error({ msg: "after-commit work failed", orgId, consumer, error: String(error) })
    }
  }
}
