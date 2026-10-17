import { idSchema } from "@patchgrid/contracts"
import { z } from "zod"

import { jobId } from "../../jobs/job-id"

export const WEBHOOK_DELIVER_QUEUE = "webhook-deliver"

export const deliverJobSchema = z.object({ orgId: idSchema, deliveryId: idSchema })
export type DeliverJob = z.infer<typeof deliverJobSchema>

/**
 * An attempt of a delivery, as a job. The job is a hint, never the truth: the
 * attempt claims the delivery in the database first, so a duplicate job (a
 * sweep re-queueing, a retry racing a replay) finds nothing to claim and does
 * nothing. `key` keeps ids unique where they must differ: `a<attempt>` for the
 * next attempt, with a suffix for a postponement or a sweep.
 */
export function deliveryJob(orgId: string, deliveryId: string, key: string, delayMs: number) {
  return {
    name: "deliver",
    data: { orgId, deliveryId } satisfies DeliverJob,
    opts: { jobId: jobId(WEBHOOK_DELIVER_QUEUE, orgId, deliveryId, key), ...(delayMs > 0 ? { delay: delayMs } : {}) },
  }
}
