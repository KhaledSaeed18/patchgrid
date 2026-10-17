import { commentVisibilitySchema, idSchema, ticketStatusSchema } from "@patchgrid/contracts"
import { z } from "zod"

/**
 * What happened, as the outbox carries it (ADR-0018, ADR-0049): ids only,
 * never entities, so the consumer reads the ticket as it is when it runs.
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
  /** A Change submitted for approval: its eligible approvers hear (DOMAIN.md §8). */
  z.object({ kind: z.literal("change-submitted"), ticketId: idSchema, actorMembershipId: actor }),
  /** A decision on a Change: its requester and assignee hear, the rejection's reason riding along. */
  z.object({
    kind: z.literal("change-decided"),
    ticketId: idSchema,
    actorMembershipId: actor,
    decision: z.enum(["APPROVED", "REJECTED"]),
    comment: carried,
  }),
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

