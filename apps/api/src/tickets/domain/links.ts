import type { LinkKind, LinkRelation, TicketType } from "@patchgrid/contracts"

export type { LinkRelation }

export type LinkEnd = { id: string; type: TicketType }
export type StoredLink = { fromTicketId: string; toTicketId: string; relation: LinkRelation }

export type Canonical = { ok: true; link: StoredLink } | { ok: false; reason: string }

/** Each reading, the relation it is stored as, and which end it is read from. */
const READINGS: Record<LinkKind, { relation: LinkRelation; reversed: boolean }> = {
  CAUSED_BY: { relation: "CAUSED_BY", reversed: false },
  CAUSES: { relation: "CAUSED_BY", reversed: true },
  RESOLVED_BY: { relation: "RESOLVED_BY", reversed: false },
  RESOLVES: { relation: "RESOLVED_BY", reversed: true },
  DUPLICATE_OF: { relation: "DUPLICATE_OF", reversed: false },
  HAS_DUPLICATE: { relation: "DUPLICATE_OF", reversed: true },
  RELATES_TO: { relation: "RELATES_TO", reversed: false },
}

/** Which types each stored relation joins, `from` → `to` (DOMAIN.md §1's table). */
function typesFit(relation: LinkRelation, from: TicketType, to: TicketType): string | null {
  switch (relation) {
    case "CAUSED_BY":
      return from === "INCIDENT" && to === "PROBLEM" ? null : "An incident is caused by a problem"
    case "RESOLVED_BY":
      return from === "PROBLEM" && to === "CHANGE" ? null : "A problem is resolved by a change"
    case "DUPLICATE_OF":
      return from === to && (from === "INCIDENT" || from === "SERVICE_REQUEST")
        ? null
        : "Only an incident or a service request is a duplicate, and only of one of its own type"
    case "RELATES_TO":
      return null
  }
}

/**
 * "This ticket <kind> that one", turned into the one row that states it:
 * the canonical direction, the types the relation joins, never a ticket to
 * itself, and a symmetric `RELATES_TO` stored lower id first so it exists
 * once. Pure — a `DUPLICATE_OF` target is already its survivor (the service
 * follows the chain before calling).
 */
export function canonicalLink(kind: LinkKind, self: LinkEnd, other: LinkEnd): Canonical {
  if (self.id === other.id) return { ok: false, reason: "A ticket cannot be linked to itself" }
  const { relation, reversed } = READINGS[kind]
  let [from, to] = reversed ? [other, self] : [self, other]
  const misfit = typesFit(relation, from.type, to.type)
  if (misfit !== null) return { ok: false, reason: misfit }
  if (relation === "RELATES_TO" && from.id > to.id) [from, to] = [to, from]
  return { ok: true, link: { fromTicketId: from.id, toTicketId: to.id, relation } }
}

/** A stored link as read from one of its ends. */
export function readFrom(link: StoredLink, selfId: string): LinkKind {
  if (link.relation === "RELATES_TO" || link.fromTicketId === selfId) return link.relation
  switch (link.relation) {
    case "CAUSED_BY":
      return "CAUSES"
    case "RESOLVED_BY":
      return "RESOLVES"
    case "DUPLICATE_OF":
      return "HAS_DUPLICATE"
  }
}
