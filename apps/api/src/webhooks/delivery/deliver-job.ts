import { idSchema } from "@patchgrid/contracts"
import { z } from "zod"

import { jobId } from "../../jobs/job-id"

export const WEBHOOK_DELIVER_QUEUE = "webhook-deliver"

/** `turnedAway` counts how often the tenant's cap sent this job back, so each wait is longer (ADR-0050). */
export const deliverJobSchema = z.object({ orgId: idSchema, deliveryId: idSchema, turnedAway: z.int().nonnegative().default(0) })
export type DeliverJob = z.infer<typeof deliverJobSchema>

/**
 * The job for a delivery's next attempt, due `at`. The job is a hint, never
 * the truth: the attempt claims the delivery in the database first, so a
 * duplicate finds nothing to claim. Its id is the time it is for, so every
 * party that schedules the same attempt (the consumer, a retry, the sweep, a
 * replay) names the same job and BullMQ keeps one; a rescheduled attempt is a
 * new time and a new job. A job that fails is not kept, so its id is free for
 * the sweep to use again.
 */
export function deliveryJob(orgId: string, deliveryId: string, at: Date, now: Date) {
  const delay = Math.max(0, at.getTime() - now.getTime())
  return {
    name: "deliver",
    data: { orgId, deliveryId, turnedAway: 0 } satisfies DeliverJob,
    opts: {
      jobId: jobId(WEBHOOK_DELIVER_QUEUE, orgId, deliveryId, `t${String(at.getTime())}`),
      removeOnFail: true,
      ...(delay > 0 ? { delay } : {}),
    },
  }
}
