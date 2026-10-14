import { commentVisibilitySchema, idSchema, ticketStatusSchema } from "@patchgrid/contracts"
import { z } from "zod"

/**
 * What happened, as the `notify` job carries it (ADR-0018): ids only, never
 * entities, so the processor reads the ticket as it is when the job runs.
 * `actorMembershipId` is `null` for the system — a sweep, an automation.
 */
const actor = idSchema.nullable()
/**
 * A comment written with a transition rides with it: whoever the move does
 * not already tell hears about the comment, so nobody gets two rows for one
 * move and nobody the comment concerns is missed.
 */
const carried = commentVisibilitySchema.nullable().default(null)

export const notifyEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket-created"), ticketId: idSchema, actorMembershipId: actor }),
  z.object({ kind: z.literal("ticket-assigned"), ticketId: idSchema, actorMembershipId: actor, assigneeMembershipId: idSchema }),
  z.object({ kind: z.literal("comment-added"), ticketId: idSchema, actorMembershipId: actor, visibility: commentVisibilitySchema }),
  z.object({
    kind: z.literal("status-changed"),
    ticketId: idSchema,
    actorMembershipId: actor,
    to: ticketStatusSchema,
    comment: carried,
  }),
  z.object({ kind: z.literal("ticket-reopened"), ticketId: idSchema, actorMembershipId: actor, comment: carried }),
  z.object({ kind: z.literal("watcher-added"), ticketId: idSchema, actorMembershipId: actor, membershipId: idSchema }),
  z.object({
    kind: z.literal("sla"),
    ticketId: idSchema,
    actorMembershipId: z.null(),
    clock: z.enum(["response", "resolution"]),
    signal: z.enum(["warning", "breach"]),
  }),
])
export type NotifyEvent = z.infer<typeof notifyEventSchema>

export const notifyJobSchema = z.object({ orgId: idSchema, event: notifyEventSchema })
export type NotifyJob = z.infer<typeof notifyJobSchema>
