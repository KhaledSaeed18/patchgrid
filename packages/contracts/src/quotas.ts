import { z } from "zod"

import { type Plan, planSchema } from "./tenancy.ts"

/**
 * Plan limits (TENANCY.md §8) — the one definition the API enforces, the
 * pricing page shows and the usage panel compares against.
 *
 * `null` is unlimited. Seats are `ACTIVE` human memberships at `AGENT` or
 * above (ADR-0033): a disabled agent frees one, requesters never use one.
 */
export const usageMetricSchema = z.enum([
  "AGENT_SEATS",
  "TICKETS_CREATED",
  "STORAGE_BYTES",
  "AUTOMATION_RULES",
  "KB_ARTICLES",
])
export type UsageMetric = z.infer<typeof usageMetricSchema>

/** Cumulative per calendar month (UTC); everything else is a point-in-time count. */
export const MONTHLY_METRICS: ReadonlySet<UsageMetric> = new Set(["TICKETS_CREATED"])

const GB = 1024 ** 3

export const PLAN_LIMITS = {
  FREE: { AGENT_SEATS: 3, TICKETS_CREATED: 200, STORAGE_BYTES: GB, AUTOMATION_RULES: 3, KB_ARTICLES: 25 },
  PRO: { AGENT_SEATS: 25, TICKETS_CREATED: 10_000, STORAGE_BYTES: 25 * GB, AUTOMATION_RULES: 50, KB_ARTICLES: null },
} as const satisfies Record<Plan, Record<UsageMetric, number | null>>

export function limitFor(plan: Plan, metric: UsageMetric): number | null {
  return PLAN_LIMITS[plan][metric]
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
