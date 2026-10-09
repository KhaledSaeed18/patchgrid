import { Injectable } from "@nestjs/common"
import type { AgentVisibility, TicketStatus } from "@patchgrid/contracts"

import type { TenantActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import type { Subject } from "../authz/subject"
import { NotFoundProblem } from "../common/problems/problem.exception"
import type { ActorRelation } from "./domain/transitions"
import { type TicketRow, TicketRepository } from "./repositories/ticket.repository"

export type LoadedTicket = {
  row: TicketRow
  subject: Subject & { ticketStatus: TicketStatus }
  relation: ActorRelation
}

/**
 * Loading a ticket FOR an actor (RBAC.md §4, §11): the row, what the actor is
 * to it, and whether it is in their scope — or the 404 an invisible ticket is.
 * Every ticket, comment and watcher endpoint starts here, so visibility is
 * decided once.
 */
@Injectable()
export class TicketAccess {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly permissions: PermissionService,
  ) {}

  async load(orgId: string, id: string, actor: TenantActor, visibility: AgentVisibility): Promise<LoadedTicket> {
    const row = await this.tickets.findById(orgId, id)
    if (row === null) throw new NotFoundProblem()
    const own = row.requesterMembershipId === actor.membershipId
    const watch = own ? false : await this.tickets.isWatching(orgId, id, actor.membershipId)
    const subject = {
      own,
      watch,
      scope: this.inScope(actor, row, watch, visibility),
      ticketType: row.type,
      ticketStatus: row.status,
    }
    this.permissions.assertVisible(actor, "ticket:read", subject)
    return {
      row,
      subject,
      relation: {
        role: actor.role,
        isRequester: own,
        isAssignee: row.assigneeMembershipId === actor.membershipId,
        ticketHasAssignee: row.assigneeMembershipId !== null,
      },
    }
  }

  /** The ticket against the actor's scope filter — the same branches the lists query. */
  private inScope(actor: TenantActor, row: TicketRow, watch: boolean, visibility: AgentVisibility): boolean {
    const filter = this.permissions.scopeFor(actor, "ticket", { agentVisibility: visibility })
    if (filter.kind === "all") return true
    if (filter.kind === "none") return false
    return filter.branches.some((branch) => {
      switch (branch.kind) {
        case "teams":
          return row.teamId !== null && branch.teamIds.includes(row.teamId)
        case "no-team":
          return row.teamId === null
        case "assignee":
          return row.assigneeMembershipId === branch.membershipId
        case "requester":
          return row.requesterMembershipId === branch.membershipId
        case "watcher":
          return watch
        case "owner":
          return false
      }
    })
  }
}
