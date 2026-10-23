import { Injectable } from "@nestjs/common"
import type { AgentVisibility, Role, TicketStatus, TicketType } from "@patchgrid/contracts"

import type { TenantActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { type ScopedTicket, ticketInScope } from "../authz/scope-filter"

/**
 * A member as authorization sees them: what `can()` and `scopeFor()` read off
 * an actor. `userId` is `null` for an external requester (ADR-0027 §4), who
 * reads as one: their own tickets, nothing else.
 */
export type Reader = {
  membershipId: string
  userId: string | null
  role: Role
  teamIds: string[]
  leadOfTeamIds: string[]
}

/** The ticket facts a read decision needs, and who explicitly watches it. */
export type AudienceTicket = ScopedTicket & {
  type: TicketType
  status: TicketStatus
  watcherMembershipIds: ReadonlySet<string>
}

/**
 * Whether someone other than the caller may read a ticket (DOMAIN.md §8,
 * ADR-0008): the decision `TicketAccess` makes for a request, made for a
 * recipient. A notification, an email or a stream event about a ticket is a
 * read of it, so nothing is sent to a member who would get a `404` opening it
 * — a requester on a team, an assignee since demoted, an `OWN_TEAM_ONLY`
 * agent outside the ticket's team. Pure over `PermissionService`; the caller
 * loads the facts.
 */
@Injectable()
export class TicketAudience {
  constructor(private readonly permissions: PermissionService) {}

  mayRead(
    orgId: string,
    reader: Reader,
    ticket: AudienceTicket,
    visibility: AgentVisibility,
    content: "ticket" | "internal" = "ticket",
  ): boolean {
    const actor: TenantActor =
      reader.userId === null
        ? { kind: "external", orgId, membershipId: reader.membershipId, role: "REQUESTER" }
        : { kind: "member", orgId, ...reader, userId: reader.userId }
    const own = ticket.requesterMembershipId === reader.membershipId
    const watch = !own && ticket.watcherMembershipIds.has(reader.membershipId)
    const subject = {
      own,
      watch,
      scope: ticketInScope(this.permissions.scopeFor(actor, "ticket", { agentVisibility: visibility }), ticket, watch),
      ticketType: ticket.type,
      ticketStatus: ticket.status,
    }
    if (!this.permissions.can(actor, "ticket:read", subject)) return false
    return content === "ticket" || this.permissions.can(actor, "comment:read_internal", subject)
  }
}
