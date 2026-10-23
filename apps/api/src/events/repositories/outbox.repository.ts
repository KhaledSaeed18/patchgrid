import { Injectable } from "@nestjs/common"
import { v7 as uuidv7 } from "uuid"

import { PrismaService } from "../../prisma/prisma.service"

/** An event as the log holds it: its place, `(txn, id)`, and what it says. */
export type StoredEvent = { id: string; txn: bigint; type: string; payload: unknown; occurredAt: Date }

/** A place in the log. The start is before every event. */
export type LogPosition = { txn: bigint; id: string }
export const LOG_START: LogPosition = { txn: 0n, id: "00000000-0000-0000-0000-000000000000" }

export type ConsumerCursor = LogPosition & { failingEventId: string | null; failures: number; failedAt: Date | null }

export type NewEvent = { type: string; payload: Record<string, unknown> }

/**
 * The outbox (ADR-0049). Tenant-owned: every method takes the org and filters
 * on it, and runs inside the caller's transaction, which set the tenant for
 * RLS. The raw statements are the ones Prisma cannot say: a row comparison, the
 * snapshot horizon, an advisory lock. They go through `prisma.tx`, which throws
 * outside a transaction rather than let RLS answer "nothing".
 */
@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(orgId: string, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return
    // `txn` is the column default: the writing transaction's id, assigned by Postgres.
    await this.prisma.db.outboxEvent.createMany({
      data: events.map((e) => ({ id: uuidv7(), orgId, type: e.type, payload: e.payload as object })),
    })
  }

  /**
   * Serialises the drains of one consumer in one tenant, for this transaction.
   * `try`, so a second drain returns at once instead of holding a pooled
   * connection; an advisory lock assigns no transaction id, so taking it does
   * not move the drainer's own horizon.
   */
  async tryLock(orgId: string, consumer: string): Promise<boolean> {
    const rows = await this.prisma.tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`outbox:${orgId}:${consumer}`}, 0)) AS locked`
    return rows[0]?.locked === true
  }

  /**
   * The same lock, waited for: a replay runs one event through its consumer
   * and must not interleave with a drain of it, but a person asked for it and
   * a drain holds the lock for one batch at most.
   */
  async lock(orgId: string, consumer: string): Promise<void> {
    await this.prisma.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`outbox:${orgId}:${consumer}`}, 0))`
  }

  /** The consumer's place; a consumer that has never run starts before every event. Reads only. */
  async cursor(orgId: string, consumer: string): Promise<ConsumerCursor> {
    const row = await this.prisma.db.eventConsumer.findUnique({
      where: { orgId_consumer: { orgId, consumer } },
      select: { cursorTxn: true, cursorEventId: true, failingEventId: true, failures: true, updatedAt: true },
    })
    if (row === null) return { ...LOG_START, failingEventId: null, failures: 0, failedAt: null }
    // A cursor with a failure was last written by `recordFailure`: its `updatedAt` is when.
    return { txn: row.cursorTxn, id: row.cursorEventId, failingEventId: row.failingEventId, failures: row.failures, failedAt: row.failures > 0 ? row.updatedAt : null }
  }

  /**
   * The next events after `after`, in log order, and only those below the
   * snapshot horizon: every transaction older than the oldest one still
   * running has finished, so nothing below it can still appear (ADR-0049).
   * `heldBack` says whether committed events wait above the horizon, so the
   * caller comes back soon rather than at the next wake.
   *
   * Must be the drain's first read after the lock, before it writes: a
   * transaction that has written holds an id, and its own id is a horizon.
   */
  async read(orgId: string, after: LogPosition, limit: number): Promise<{ events: StoredEvent[]; heldBack: boolean }> {
    const events = await this.prisma.tx.$queryRaw<StoredEvent[]>`
      SELECT "id", "txn", "type", "payload", "occurredAt" FROM "OutboxEvent"
       WHERE "orgId" = ${orgId}::uuid
         AND ("txn", "id") > (${after.txn}::bigint, ${after.id}::uuid)
         AND "txn" < (pg_snapshot_xmin(pg_current_snapshot())::text)::bigint
       ORDER BY "txn", "id"
       LIMIT ${limit}`
    if (events.length === limit) return { events, heldBack: false }
    const last = events.at(-1) ?? after
    const held = await this.prisma.tx.$queryRaw<{ held: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "OutboxEvent"
         WHERE "orgId" = ${orgId}::uuid AND ("txn", "id") > (${last.txn}::bigint, ${last.id}::uuid)
      ) AS held`
    return { events, heldBack: held[0]?.held === true }
  }

  /** Whether the consumer has anything left to read, horizon or not — the sweep's question. */
  async lagging(orgId: string, consumer: string): Promise<boolean> {
    const rows = await this.prisma.tx.$queryRaw<{ lagging: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "OutboxEvent" e
          LEFT JOIN "EventConsumer" c ON c."orgId" = e."orgId" AND c."consumer" = ${consumer}
         WHERE e."orgId" = ${orgId}::uuid
           AND (e."txn", e."id") > (COALESCE(c."cursorTxn", 0), COALESCE(c."cursorEventId", ${LOG_START.id}::uuid))
      ) AS lagging`
    return rows[0]?.lagging === true
  }

  /** Moves the cursor past `to` and forgets any failure: the event it was stuck on is behind it. */
  async advance(orgId: string, consumer: string, to: LogPosition): Promise<void> {
    await this.prisma.db.eventConsumer.upsert({
      where: { orgId_consumer: { orgId, consumer } },
      create: { orgId, consumer, cursorTxn: to.txn, cursorEventId: to.id },
      update: { cursorTxn: to.txn, cursorEventId: to.id, failingEventId: null, failures: 0, lastError: null },
    })
  }

  /**
   * Counts a failure of `event`; a different event than last time starts the
   * count again. Under the consumer's lock, and only while the cursor is still
   * before the event: a drain that lost the race, or one whose event another
   * drain has since handled, records nothing. Returns the count, or `null`
   * when it recorded nothing.
   */
  async recordFailure(orgId: string, consumer: string, event: LogPosition, error: string): Promise<number | null> {
    if (!(await this.tryLock(orgId, consumer))) return null
    const cursor = await this.cursor(orgId, consumer)
    if (cursor.txn > event.txn || (cursor.txn === event.txn && cursor.id >= event.id)) return null
    const rows = await this.prisma.tx.$queryRaw<{ failures: number }[]>`
      INSERT INTO "EventConsumer" ("orgId", "consumer", "failingEventId", "failures", "lastError", "updatedAt")
      VALUES (${orgId}::uuid, ${consumer}, ${event.id}::uuid, 1, ${error}, now())
      ON CONFLICT ("orgId", "consumer") DO UPDATE SET
        "failures" = CASE WHEN "EventConsumer"."failingEventId" = EXCLUDED."failingEventId"
                          THEN "EventConsumer"."failures" + 1 ELSE 1 END,
        "failingEventId" = EXCLUDED."failingEventId",
        "lastError" = EXCLUDED."lastError",
        "updatedAt" = now()
      RETURNING "failures"`
    return rows[0]?.failures ?? 1
  }

  /** Gives up on one event: it goes to the dead letters, and the cursor moves past it. */
  async park(orgId: string, consumer: string, event: StoredEvent, failures: number, error: string): Promise<void> {
    await this.prisma.db.eventDeadLetter.upsert({
      where: { orgId_consumer_eventId: { orgId, consumer, eventId: event.id } },
      create: { orgId, consumer, eventId: event.id, failures, error },
      update: {},
    })
    await this.advance(orgId, consumer, event)
  }
}

