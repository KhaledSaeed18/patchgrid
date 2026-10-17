import { z } from "zod"

import { prioritySchema } from "./priority.ts"
import { ticketTypeSchema } from "./ticket-number.ts"

/**
 * Reports (ADR-0051), read from the reporting read side. Ranges are half-open,
 * `[from, to)`, at most a year; durations are whole minutes.
 */
export const MAX_REPORT_RANGE_DAYS = 366

export const reportGroupSchema = z.enum(["priority", "type", "team", "category", "assignee"])
export type ReportGroup = z.infer<typeof reportGroupSchema>

export const reportRangeQuerySchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), groupBy: reportGroupSchema.default("priority") })
  .refine((q) => new Date(q.from) < new Date(q.to), { error: "from must be before to", path: ["to"] })
  .refine((q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= MAX_REPORT_RANGE_DAYS * 86_400_000, {
    error: `a range is at most ${String(MAX_REPORT_RANGE_DAYS)} days`,
    path: ["from"],
  })
export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>

/** One group of the SLA report: what met and missed its targets, and how long resolution took. */
export const slaReportRowSchema = z.object({
  /** The group's value: a priority or type, or an id; `null` for none (no team, no category, unassigned). */
  key: z.string().nullable(),
  label: z.string(),
  /** Tickets raised in the range, by how their response clock stands now. */
  response: z.object({ met: z.int(), breached: z.int(), running: z.int() }),
  /** Tickets resolved in the range, by how their resolution clock ended. */
  resolution: z.object({ met: z.int(), breached: z.int() }),
  resolved: z.int(),
  medianResolutionMinutes: z.number().nullable(),
  p90ResolutionMinutes: z.number().nullable(),
})
export type SlaReportRow = z.infer<typeof slaReportRowSchema>

export const slaReportSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  groupBy: reportGroupSchema,
  rows: z.array(slaReportRowSchema),
  total: slaReportRowSchema,
})
export type SlaReport = z.infer<typeof slaReportSchema>

/** How old the open tickets are. Buckets are by age at the moment of asking. */
export const BACKLOG_BUCKETS = ["under 1 day", "1 to 3 days", "3 to 7 days", "7 to 30 days", "over 30 days"] as const
export const backlogReportSchema = z.object({
  buckets: z.array(z.enum(BACKLOG_BUCKETS)),
  rows: z.array(z.object({ priority: prioritySchema, counts: z.array(z.int()) })),
  byType: z.array(z.object({ type: ticketTypeSchema, open: z.int() })),
})
export type BacklogReport = z.infer<typeof backlogReportSchema>

/** Who holds the open work, and who resolved what in the range. */
export const workloadReportSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  rows: z.array(
    z.object({ membershipId: z.string().nullable(), label: z.string(), open: z.int(), resolvedInRange: z.int(), breachedOpen: z.int() }),
  ),
})
export type WorkloadReport = z.infer<typeof workloadReportSchema>
