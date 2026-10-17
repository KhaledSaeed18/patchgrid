import { z } from "zod"

import { idSchema } from "./id.ts"
import { commentInputSchema, ticketActionSchema } from "./tickets.ts"

/** Tickets one bulk action may name: bounded so the request finishes in seconds (ADR-0052). */
export const MAX_BULK_TICKETS = 200

const bulkTicketsSchema = z
  .array(z.strictObject({ id: idSchema, version: z.int().positive() }))
  .min(1)
  .max(MAX_BULK_TICKETS)
  .refine((tickets) => new Set(tickets.map((t) => t.id)).size === tickets.length, "names a ticket twice")

/**
 * One action, many tickets, each with the version its row showed. The action is
 * exactly the single route's: an assignment, or a transition with its comment.
 */
export const bulkTicketRequestSchema = z.strictObject({
  /** Names this run's progress frames on the live stream; the client chooses it. */
  operationId: idSchema,
  tickets: bulkTicketsSchema,
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("assign"), assigneeMembershipId: idSchema.nullable().optional(), teamId: idSchema.nullable().optional() }),
    z.strictObject({ kind: z.literal("transition"), action: ticketActionSchema.exclude(["assign"]), comment: commentInputSchema.optional() }),
  ]),
}).refine((r) => r.action.kind !== "assign" || r.action.assigneeMembershipId !== undefined || r.action.teamId !== undefined, {
  error: "an assignment sets an assignee, a team, or both",
  path: ["action"],
})
export type BulkTicketRequest = z.infer<typeof bulkTicketRequestSchema>

/**
 * How one ticket fared: `done`; `conflict`, its version moved (someone else
 * changed it); `refused`, not permitted or no such move from its status, with
 * the single action's reason; `not-found`, not a ticket this agent can see.
 */
export const bulkOutcomeSchema = z.enum(["done", "conflict", "refused", "not-found"])
export type BulkOutcome = z.infer<typeof bulkOutcomeSchema>

export const bulkTicketResultSchema = z.object({
  total: z.int(),
  done: z.int(),
  results: z.array(z.object({ ticketId: idSchema, outcome: bulkOutcomeSchema, detail: z.string().nullable() })),
})
export type BulkTicketResult = z.infer<typeof bulkTicketResultSchema>

/** A progress frame on the acting member's own live stream while a bulk action runs. */
export const bulkProgressEventSchema = z.object({ operationId: idSchema, processed: z.int(), total: z.int() })
export type BulkProgressEvent = z.infer<typeof bulkProgressEventSchema>
