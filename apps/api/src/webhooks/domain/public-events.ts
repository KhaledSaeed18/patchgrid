import { formatTicketNumber, type TicketType, type WebhookEventData, type WebhookEventType } from "@patchgrid/contracts"

import type { NotifyEvent } from "../../notifications/notify-events"

/** What never changes about a ticket: all a webhook says about it besides the event (ADR-0050). */
export type TicketFacts = { id: string; number: number; type: TicketType }

/**
 * The public face of a log event, or `null` when it has none: an internal
 * note, a watcher added, or a type the catalogue does not carry. Renaming an
 * internal event never changes the wire; this is the one place they meet.
 */
export function publicEvent(event: NotifyEvent, ticket: TicketFacts): WebhookEventData | null {
  const ref = { id: ticket.id, number: formatTicketNumber(ticket.type, ticket.number), type: ticket.type }
  const by = event.actorMembershipId
  switch (event.kind) {
    case "ticket-created":
      return { type: "ticket.created", ticket: ref, actorMembershipId: by }
    case "ticket-assigned":
      return { type: "ticket.assigned", ticket: ref, actorMembershipId: by, assigneeMembershipId: event.assigneeMembershipId }
    case "status-changed":
      return { type: "ticket.status_changed", ticket: ref, actorMembershipId: by, status: event.to }
    case "ticket-reopened":
      return { type: "ticket.reopened", ticket: ref, actorMembershipId: by }
    case "comment-added":
      // An internal note is `comment:read_internal`, which no integration holds (RBAC.md §10).
      return event.visibility === "PUBLIC" ? { type: "comment.created", ticket: ref, actorMembershipId: by } : null
    case "change-submitted":
      return { type: "change.submitted", ticket: ref, actorMembershipId: by }
    case "change-decided":
      return { type: "change.decided", ticket: ref, actorMembershipId: by, decision: event.decision }
    case "sla":
      return { type: event.signal === "warning" ? "ticket.sla_warning" : "ticket.sla_breached", ticket: ref, clock: event.clock }
    case "watcher-added":
      return null
  }
}

/** The public type an internal event would become, before the ticket is read: to know which endpoints care. */
export function publicTypeOf(event: NotifyEvent): WebhookEventType | null {
  return publicEvent(event, { id: event.ticketId, number: 0, type: "INCIDENT" })?.type ?? null
}
