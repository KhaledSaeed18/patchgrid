/**
 * Waits for background work instead of sleeping a guess (ENGINEERING.md
 * §Testing): every job on the named queues that is waiting, delayed or
 * running is awaited to completion through BullMQ's own events, round after
 * round, until a look finds nothing left — a job that enqueues another
 * (`notify` → `mail`) is caught by the next round.
 */
import type { INestApplication } from "@nestjs/common"
import { getQueueToken } from "@nestjs/bullmq"
import { type Queue, QueueEvents } from "bullmq"

export type Settler = { settle: () => Promise<void>; close: () => Promise<void> }

export function settler(app: INestApplication, names: readonly string[]): Settler {
  const queues = names.map((name) => app.get<Queue>(getQueueToken(name)))
  const events = queues.map((queue) => new QueueEvents(queue.name, { connection: queue.opts.connection }))
  const ready = Promise.all(events.map((e) => e.waitUntilReady()))

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
        if (pending === 0) return
      }
    },
    async close() {
      await Promise.all(events.map((e) => e.close()))
    },
  }
}
