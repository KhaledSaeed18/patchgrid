import { Injectable } from "@nestjs/common"
import type { BulkOutcome, BulkTicketRequest, BulkTicketResult } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import {
  NotFoundProblem,
  ProblemException,
  StaleWriteProblem,
} from "../common/problems/problem.exception"
import { StreamBus } from "../notifications/live/stream-bus"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TicketsService } from "./tickets.service"

/** A progress frame after this many tickets, and after the last. */
const PROGRESS_EVERY = 10

/**
 * A bulk action is the single action, many times (ADR-0052): each ticket goes
 * through the same `applyAssign` or `applyTransition` the single routes use,
 * in its own transaction, so every permission, guard, version check, audit
 * row, event and notification is exactly a single action's. Each ticket's
 * refusal is its own; none undoes another's success.
 */
@Injectable()
export class BulkTicketsService {
  constructor(
    private readonly tickets: TicketsService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly bus: StreamBus,
  ) {}

  async run(request: BulkTicketRequest): Promise<BulkTicketResult> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "ticket:bulk")
    const orgId = this.tenant.requireOrgId()
    const total = request.tickets.length
    const results: BulkTicketResult["results"] = []
    for (const [index, ticket] of request.tickets.entries()) {
      results.push({ ticketId: ticket.id, ...(await this.one(ticket, request.action)) })
      const processed = index + 1
      if (processed % PROGRESS_EVERY === 0 || processed === total) {
        await this.bus.publish(orgId, {
          kind: "bulk-progress",
          membershipId: actor.membershipId,
          event: { operationId: request.operationId, processed, total },
        })
      }
    }
    return { total, done: results.filter((r) => r.outcome === "done").length, results }
  }

  private async one(
    ticket: { id: string; version: number },
    action: BulkTicketRequest["action"],
  ): Promise<{ outcome: BulkOutcome; detail: string | null }> {
    try {
      if (action.kind === "assign") {
        await this.tickets.applyAssign(ticket.id, {
          version: ticket.version,
          ...(action.assigneeMembershipId === undefined ? {} : { assigneeMembershipId: action.assigneeMembershipId }),
          ...(action.teamId === undefined ? {} : { teamId: action.teamId }),
        })
      } else {
        await this.tickets.applyTransition(ticket.id, {
          action: action.action,
          version: ticket.version,
          ...(action.comment === undefined ? {} : { comment: action.comment }),
        })
      }
      return { outcome: "done", detail: null }
    } catch (error) {
      // A problem is this ticket's answer; anything else is a fault, and stops the run as it would a single action.
      if (!(error instanceof ProblemException)) throw error
      if (error instanceof StaleWriteProblem) return { outcome: "conflict", detail: "Someone changed it since you loaded it" }
      if (error instanceof NotFoundProblem) return { outcome: "not-found", detail: null }
      return { outcome: "refused", detail: error.message }
    }
  }
}
