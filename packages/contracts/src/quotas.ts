import { z } from "zod"

import { MAX_ATTACHMENT_BYTES } from "./limits.ts"
import { type Plan, planSchema } from "./tenancy.ts"

/**
 * Plan limits (TENANCY.md §8) — the one definition the API enforces, the
 * pricing page shows and the usage panel compares against.
 *
 * `null` is unlimited. Seats are `ACTIVE` human memberships at `AGENT` or
 * above (ADR-0033): a disabled agent frees one, requesters never use one.
 * A token's service account holds no seat; the tokens have their own limit,
 * counted while unrevoked.
 */
export const usageMetricSchema = z.enum(["AGENT_SEATS", "TICKETS_CREATED", "STORAGE_BYTES", "KB_ARTICLES", "API_TOKENS"])
export type UsageMetric = z.infer<typeof usageMetricSchema>

/** Cumulative per calendar month (UTC); everything else is a point-in-time count. */
export const MONTHLY_METRICS: ReadonlySet<UsageMetric> = new Set(["TICKETS_CREATED"])

const GB = 1024 ** 3

export const PLAN_LIMITS = {
  FREE: { AGENT_SEATS: 3, TICKETS_CREATED: 200, STORAGE_BYTES: GB, KB_ARTICLES: 25, API_TOKENS: 5 },
  PRO: { AGENT_SEATS: 25, TICKETS_CREATED: 10_000, STORAGE_BYTES: 25 * GB, KB_ARTICLES: null, API_TOKENS: 50 },
} as const satisfies Record<Plan, Record<UsageMetric, number | null>>

/**
 * How long a workspace's audit log is kept, by plan (ADR-0028). The longest is
 * the partition archival's window (ADR-0034); a shorter one is a per-tenant
 * delete in the retention sweep.
 */
export const AUDIT_RETENTION_YEARS = { FREE: 2, PRO: 7 } as const satisfies Record<Plan, number>

export function limitFor(plan: Plan, metric: UsageMetric): number | null {
  return PLAN_LIMITS[plan][metric]
}

/**
 * The usage at which a limit counts as reached, for the admins' notification
 * (DOMAIN.md §8): the limit itself, except storage, which is full once the
 * largest file a member may upload no longer fits.
 */
export function limitReachedAt(metric: UsageMetric, limit: number): number {
  return metric === "STORAGE_BYTES" ? Math.max(0, limit - MAX_ATTACHMENT_BYTES) : limit
}

/** `YYYY-MM` in UTC for a monthly metric; `current` for a point-in-time one. */
export function usagePeriod(metric: UsageMetric, at: Date): string {
  return MONTHLY_METRICS.has(metric) ? at.toISOString().slice(0, 7) : "current"
}

/** `GET /org/usage` — what the admin's usage panel and the over-limit banner read. */
export const usageSchema = z.object({
  plan: planSchema,
  metrics: z.array(
    z.object({ metric: usageMetricSchema, period: z.string(), used: z.number().nonnegative(), limit: z.number().nullable() }),
  ),
})
export type Usage = z.infer<typeof usageSchema>
