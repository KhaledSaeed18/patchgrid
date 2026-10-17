/**
 * Waits for background work instead of sleeping a guess (ENGINEERING.md
 * §Testing): every job on the named queues that is waiting, delayed or
 * running is awaited to completion through BullMQ's own events, round after
 * round, until a look finds nothing left — a job that enqueues another
 * (a drain → `mail`) is caught by the next round.
 *
 * With the outbox's drain queue among them, a round also asks the log itself
 * (ADR-0049): the wake on commit is asynchronous, so an empty queue proves
 * nothing until no consumer has anything left to read.
 */
import type { INestApplication } from "@nestjs/common"
import { getQueueToken } from "@nestjs/bullmq"
import { createPrismaClient } from "@patchgrid/database"
import { type Queue, QueueEvents } from "bullmq"

import { CONSUMER_NAMES, type ConsumerName } from "../../src/events/consumer"
import { DrainRequests, OUTBOX_DRAIN_QUEUE } from "../../src/events/drain-requests"
import { requireEnv } from "./env"

export type Settler = { settle: () => Promise<void>; close: () => Promise<void> }

export function settler(app: INestApplication, names: readonly string[], options: { followOutbox?: boolean } = {}): Settler {
  const queues = names.map((name) => app.get<Queue>(getQueueToken(name)))
  const events = queues.map((queue) => new QueueEvents(queue.name, { connection: queue.opts.connection }))
  const ready = Promise.all(events.map((e) => e.waitUntilReady()))
  // The owner role reads every tenant's cursors at once; test support only, never the app.
  // A spec proving the relay finds the log by itself turns this off.
  const follow = options.followOutbox ?? names.includes(OUTBOX_DRAIN_QUEUE)
  const owner = follow ? createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") }) : null

  /** Every (tenant, consumer) with events past its cursor, after asking each for a drain. */
  const behind = async (): Promise<number> => {
    if (owner === null) return 0
    const rows = await owner.$queryRawUnsafe<{ orgId: string; consumer: ConsumerName }[]>(
      `SELECT DISTINCT e."orgId"::text AS "orgId", n.consumer
         FROM "OutboxEvent" e
         CROSS JOIN unnest($1::text[]) AS n(consumer)
         LEFT JOIN "EventConsumer" c ON c."orgId" = e."orgId" AND c.consumer = n.consumer
        WHERE (e.txn, e.id) > (COALESCE(c."cursorTxn", 0), COALESCE(c."cursorEventId", '00000000-0000-0000-0000-000000000000'::uuid))`,
      [...CONSUMER_NAMES],
    )
    const requests = app.get(DrainRequests)
    await Promise.all(rows.map((r) => requests.request(r.orgId, r.consumer)))
    return rows.length
  }

  return {
    async settle() {
      await ready
      for (;;) {
        let pending = 0
        for (const [i, queue] of queues.entries()) {
          const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "active", "waiting-children"])
          pending += jobs.length
          // A job removed on completion between the look and the wait is finished; so is a failed one.
          await Promise.all(jobs.map((job) => job.waitUntilFinished(events[i] as QueueEvents).catch(() => undefined)))
        }
        if (pending === 0 && (await behind()) === 0) return
      }
    },
    async close() {
      await Promise.all(events.map((e) => e.close()))
      await owner?.$disconnect()
    },
  }
}
