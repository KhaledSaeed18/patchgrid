import { z } from "zod"

import { idSchema } from "./id.ts"
import { prioritySchema } from "./priority.ts"
import { ticketTypeSchema } from "./ticket-number.ts"
import { ticketSortSchema, ticketStatusSchema, ticketViewSchema } from "./tickets.ts"

/** Saved views per person (ADR-0052). */
export const MAX_SAVED_VIEWS = 20

/**
 * What a saved view keeps: the list query, never its results. Opening it runs
 * the query as the person opening it, so their own visibility decides what
 * they see.
 */
export const savedViewQuerySchema = z.strictObject({
  view: ticketViewSchema.exclude(["mine", "all"]),
  type: ticketTypeSchema.optional(),
  status: ticketStatusSchema.optional(),
  priority: prioritySchema.optional(),
  sort: ticketSortSchema.default("newest"),
})
export type SavedViewQuery = z.infer<typeof savedViewQuerySchema>

export const createSavedViewRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  query: savedViewQuerySchema,
  /** Share it with one of your teams; omitted or null keeps it yours. */
  teamId: idSchema.nullable().optional(),
})
export type CreateSavedViewRequest = z.infer<typeof createSavedViewRequestSchema>

export const savedViewSchema = z.object({
  id: idSchema,
  name: z.string(),
  query: savedViewQuerySchema,
  team: z.object({ id: idSchema, name: z.string() }).nullable(),
  owner: z.object({ membershipId: idSchema, displayName: z.string() }),
  /** Whether the reader may remove it: its author, or for a shared view, the team's lead or an admin. */
  removable: z.boolean(),
})
export type SavedView = z.infer<typeof savedViewSchema>
