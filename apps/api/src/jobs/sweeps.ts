import { type Job, UnrecoverableError } from "bullmq"
import { z } from "zod"

/**
 * The per-tenant sweeps (ADR-0018). Each runs on its own queue, one job per
 * organization per tick, enqueued by the dispatcher; none scans across tenants.
 * `everyMs` is how often the dispatcher fans the sweep out.
 */
export const SWEEPS = {
  /** Warn before, and flag after, an SLA target (DOMAIN.md §4.3). */
  "sla-scan": { everyMs: 60_000 },
  /** Close what has sat resolved for AUTO_CLOSE_DAYS (DOMAIN.md §2.1). */
  "auto-close": { everyMs: 15 * 60_000 },
} as const

export type SweepName = keyof typeof SWEEPS
export const SWEEP_NAMES = Object.keys(SWEEPS) as SweepName[]

/** What the dispatcher puts on a sweep queue: the tenant, and the tick it belongs to. */
export const tenantSweepJobSchema = z.object({ orgId: z.uuid(), tick: z.int().nonnegative() })
export type TenantSweepJob = z.infer<typeof tenantSweepJobSchema>

/**
 * A sweep job's payload, or an `UnrecoverableError`: a tenant queue never runs
 * a job that does not name its tenant (ENGINEERING.md, isolation assertion 8),
 * and retrying an unreadable payload changes nothing.
 */
export function readTenantSweep(job: Pick<Job, "id" | "data">): TenantSweepJob {
  const parsed = tenantSweepJobSchema.safeParse(job.data)
  if (!parsed.success) {
    throw new UnrecoverableError(`sweep job ${String(job.id)} does not name its tenant: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * The tick a moment falls in: the same number for every dispatch within one
 * interval, so a retried or duplicated dispatch enqueues the same job ids and
 * BullMQ drops the copies.
 */
export function sweepTick(now: Date, everyMs: number): number {
  return Math.floor(now.getTime() / everyMs)
}

/**
 * BullMQ priority (lower runs first). A paying tenant's sweep is not queued
 * behind a free one's; within a plan, order of enqueue. Recent volume is
 * ADR-0018's second input — it waits until a tenant is big enough to matter.
 */
export function sweepPriority(plan: "FREE" | "PRO"): number {
  return plan === "PRO" ? 1 : 2
}
