import { formatTicketNumber, type NotificationType, type TicketStatus, type TicketType } from "@patchgrid/contracts"

import type { NotifyEvent } from "./notify-events"

/** A member who might be told: their membership, their delivery address, and whether they still belong. */
export type Person = { membershipId: string; userId: string; active: boolean }

/** The ticket and the people around it, as they are when the job runs. */
export type TicketCircle = {
  ticket: { id: string; type: TicketType; number: number; title: string; status: TicketStatus }
  requester: Person
  assignee: Person | null
  /** Every member of the ticket's team, for "a ticket arrived" (in-app only). */
  teamMembers: Person[]
  teamLeads: Person[]
  /** Explicit `TicketWatcher` rows; the requester and assignee watch implicitly. */
  watchers: Person[]
  /** Active admins and owners, for a breach. */
  admins: Person[]
  /** For "raised for you": who raised it, by name. */
  actorName: string | null
}

export type Delivery = {
  person: Person
  type: NotificationType
  title: string
  dedupeKey: string | null
}

const STATUS_WORDS: Partial<Record<TicketStatus, string>> = {
  PENDING: "is waiting for your reply",
  RESOLVED: "was resolved",
  CLOSED: "was closed",
}

/**
 * Who hears about an event, and what they read (DOMAIN.md §8). Pure: the
 * processor loads the circle, this decides. Never the actor themselves, never
 * a member who has since left, never anyone twice. Internal notes reach only
 * the assignee — never a watcher, who may be a requester.
 */
export function deliveriesFor(event: NotifyEvent, circle: TicketCircle): Delivery[] {
  const { ticket } = circle
  const ref = `${formatTicketNumber(ticket.type, ticket.number)}: ${ticket.title}`
  const out = new Map<string, Delivery>()
  const send = (people: (Person | null)[], type: NotificationType, title: string, dedupeKey: string | null = null) => {
    for (const person of people) {
      if (person === null || !person.active) continue
      if (person.membershipId === event.actorMembershipId) continue
      if (!out.has(person.membershipId)) out.set(person.membershipId, { person, type, title, dedupeKey })
    }
  }

  switch (event.kind) {
    case "ticket-created":
      if (event.actorMembershipId !== null && event.actorMembershipId !== circle.requester.membershipId) {
        send([circle.requester], "TICKET_RAISED_FOR_YOU", `${circle.actorName ?? "Support"} raised ${ref} for you`)
      }
      send(circle.teamMembers, "TICKET_CREATED", `New ticket ${ref}`)
      break
    case "ticket-assigned": {
      const assignee = circle.assignee?.membershipId === event.assigneeMembershipId ? circle.assignee : null
      send([assignee], "TICKET_ASSIGNED", `Assigned to you — ${ref}`)
      break
    }
    case "comment-added":
      if (event.visibility === "INTERNAL") {
        send([circle.assignee], "COMMENT_INTERNAL", `Internal note on ${ref}`, `note:${ticket.id}`)
      } else {
        send([circle.requester, circle.assignee, ...circle.watchers], "COMMENT_PUBLIC", `New reply on ${ref}`, `comment:${ticket.id}`)
      }
      break
    case "status-changed": {
      const words = STATUS_WORDS[event.to]
      if (words !== undefined) {
        send([circle.requester, ...circle.watchers], "STATUS_CHANGED", `${formatTicketNumber(ticket.type, ticket.number)} ${words} — ${ticket.title}`, `status:${ticket.id}`)
      }
      break
    }
    case "ticket-reopened":
      send([circle.assignee, ...circle.teamLeads], "TICKET_REOPENED", `Reopened — ${ref}`)
      break
    case "watcher-added": {
      const added = circle.watchers.find((w) => w.membershipId === event.membershipId) ?? null
      send([added], "WATCHER_ADDED", `You're watching ${ref}`)
      break
    }
    case "sla": {
      const target = event.clock === "response" ? "first response" : "resolution"
      const people = [circle.assignee, ...circle.teamLeads, ...(event.signal === "breach" ? circle.admins : [])]
      if (event.signal === "warning") {
        send(people, "SLA_WARNING", `${ref} — ${target} target is close`, `sla:${ticket.id}:${event.clock}:warning`)
      } else {
        send(people, "SLA_BREACHED", `${ref} — ${target} target missed`, `sla:${ticket.id}:${event.clock}:breach`)
      }
      break
    }
  }
  return [...out.values()]
}
