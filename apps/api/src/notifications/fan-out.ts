import {
  type AgentVisibility,
  type EmailPrefs,
  emailWanted,
  formatTicketNumber,
  type NotificationType,
  type TicketStatus,
  type TicketType,
} from "@patchgrid/contracts"

import type { Reader } from "./audience"
import type { NotifyEvent } from "./notify-events"

/**
 * A member who might be told: their membership, their delivery address,
 * whether they still belong, and the role and teams a read decision needs.
 */
export type Person = Reader & { active: boolean; email: string; emailPrefs: EmailPrefs }

/** The ticket and the people around it, as they are when the job runs. */
export type TicketCircle = {
  ticket: {
    id: string
    type: TicketType
    number: number
    title: string
    status: TicketStatus
    teamId: string | null
    requesterMembershipId: string
    assigneeMembershipId: string | null
  }
  /** The workspace: its visibility decides who may read the ticket; the rest addresses the email. */
  org: { name: string; slug: string; visibility: AgentVisibility; emailEnabled: boolean }
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

/** How a delivery travels. In-app writes an inbox row; email is further subject to preferences. */
export type Channels = { inApp: boolean; email: boolean }
const BOTH: Channels = { inApp: true, email: true }

export type Delivery = {
  person: Person
  type: NotificationType
  title: string
  dedupeKey: string | null
  channels: Channels
}

const STATUS_WORDS: Partial<Record<TicketStatus, string>> = {
  PENDING: "is waiting for your reply",
  RESOLVED: "was resolved",
  CLOSED: "was closed",
}

/**
 * Who hears about an event, what they read, and by which channels (DOMAIN.md
 * §8). Pure: the processor loads the circle, this decides. Never the actor
 * themselves — save a requester's confirmation of their own ticket, which is
 * email only — never a member who has since left, never anyone twice.
 * Internal notes reach only the assignee — never a watcher, who may be a
 * requester. A ticket's arrival reaches its team in-app only.
 */
export function deliveriesFor(event: NotifyEvent, circle: TicketCircle): Delivery[] {
  const { ticket } = circle
  const ref = `${formatTicketNumber(ticket.type, ticket.number)}: ${ticket.title}`
  const out = new Map<string, Delivery>()
  const send = (
    people: (Person | null)[],
    type: NotificationType,
    title: string,
    dedupeKey: string | null = null,
    channels: Channels = BOTH,
    includeActor = false,
  ) => {
    for (const person of people) {
      if (person === null || !person.active) continue
      if (person.membershipId === event.actorMembershipId && !includeActor) continue
      if (!out.has(person.membershipId)) out.set(person.membershipId, { person, type, title, dedupeKey, channels })
    }
  }

  // `send` keeps each member's first delivery, so a comment carried by a move
  // reaches only those the move itself did not.
  const comment = (visibility: "PUBLIC" | "INTERNAL") => {
    if (visibility === "INTERNAL") {
      send([circle.assignee], "COMMENT_INTERNAL", `Internal note on ${ref}`, `note:${ticket.id}`)
    } else {
      send([circle.requester, circle.assignee, ...circle.watchers], "COMMENT_PUBLIC", `New reply on ${ref}`, `comment:${ticket.id}`)
    }
  }

  switch (event.kind) {
    case "ticket-created":
      if (event.actorMembershipId !== null && event.actorMembershipId !== circle.requester.membershipId) {
        send([circle.requester], "TICKET_RAISED_FOR_YOU", `${circle.actorName ?? "Support"} raised ${ref} for you`)
      } else {
        // The requester's confirmation: they are looking at the ticket, so no inbox row — the receipt is the email.
        send([circle.requester], "TICKET_CREATED", `We've received ${ref}`, null, { inApp: false, email: true }, true)
      }
      send(circle.teamMembers, "TICKET_CREATED", `New ticket ${ref}`, null, { inApp: true, email: false })
      break
    case "ticket-assigned": {
      const assignee = circle.assignee?.membershipId === event.assigneeMembershipId ? circle.assignee : null
      send([assignee], "TICKET_ASSIGNED", `Assigned to you — ${ref}`)
      break
    }
    case "comment-added":
      comment(event.visibility)
      break
    case "status-changed": {
      const words = STATUS_WORDS[event.to]
      if (words !== undefined) {
        // The assignee is an implicit watcher (DOMAIN.md §8).
        send([circle.requester, circle.assignee, ...circle.watchers], "STATUS_CHANGED", `${formatTicketNumber(ticket.type, ticket.number)} ${words} — ${ticket.title}`, `status:${ticket.id}`)
      }
      if (event.comment !== null) comment(event.comment)
      break
    }
    case "ticket-reopened":
      send([circle.assignee, ...circle.teamLeads], "TICKET_REOPENED", `Reopened — ${ref}`)
      if (event.comment !== null) comment(event.comment)
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

/** Why this person heard, in the words an email's footer uses — their closest tie to the ticket. */
export function reasonFor(circle: TicketCircle, membershipId: string): string {
  const is = (people: (Person | null)[]) => people.some((p) => p?.membershipId === membershipId)
  if (circle.requester.membershipId === membershipId) return "you raised this ticket"
  if (circle.assignee?.membershipId === membershipId) return "this ticket is assigned to you"
  if (is(circle.watchers)) return "you're watching this ticket"
  if (is(circle.teamLeads)) return "you lead this ticket's team"
  if (is(circle.teamMembers)) return "this ticket is in your team's queue"
  return "you're an administrator of this workspace"
}

/** One email to send: to whom, what it says, and the entity its job id is idempotent on. */
export type Mailing = { person: Person; type: NotificationType; headline: string; reason: string; entityId: string }

/**
 * Which deliveries also go by email (DOMAIN.md §8): none while the workspace's
 * kill switch is off; otherwise each that travels by email and whose type the
 * member has not turned off. One with an inbox row is emailed only when that
 * row is new — a burst folded into an unread row is one email per thread,
 * not one per reply — and is idempotent on the row. An email-only delivery is
 * idempotent on the ticket and its type.
 */
export function mailingsFor(
  circle: TicketCircle,
  deliveries: readonly Delivery[],
  written: ReadonlyMap<string, { id: string; inserted: boolean }>,
): Mailing[] {
  if (!circle.org.emailEnabled) return []
  return deliveries.flatMap((d) => {
    if (!d.channels.email || !emailWanted(d.person.emailPrefs, d.type)) return []
    let entityId = `${circle.ticket.id}-${d.type.toLowerCase()}`
    if (d.channels.inApp) {
      const row = written.get(d.person.membershipId)
      if (row === undefined || !row.inserted) return []
      entityId = row.id
    }
    return [{ person: d.person, type: d.type, headline: d.title, reason: reasonFor(circle, d.person.membershipId), entityId }]
  })
}
