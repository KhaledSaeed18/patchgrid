import { Injectable, Logger } from "@nestjs/common"
import type { BulkOutcome, BulkTicketRequest, BulkTicketResult } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import {
  ConflictProblem,
  NotFoundProblem,
  ProblemException,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { RedisService } from "../redis/redis.service"
import { StreamBus } from "../notifications/live/stream-bus"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TicketsService } from "./tickets.service"

/** A progress frame after this many tickets, and after the last. */
const PROGRESS_EVERY = 10
/** One bulk action per member at a time; the lease outlives any run of 200 and frees a crashed one. */
const RUN_LEASE_SECONDS = 120

/**
 * A bulk action is the single action, many times (ADR-0052): each ticket goes
 * through the same `applyAssign` or `applyTransition` the single routes use,
 * in its own transaction, so every permission, guard, version check, audit
 * row, event and notification is exactly a single action's. Each ticket's
 * refusal is its own; none undoes another's success.
 */
@Injectable()
export class BulkTicketsService {
  private readonly logger = new Logger(BulkTicketsService.name)

  constructor(
    private readonly tickets: TicketsService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly bus: StreamBus,
    private readonly redis: RedisService,
  ) {}

  async run(request: BulkTicketRequest): Promise<BulkTicketResult> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "ticket:bulk")
    const orgId = this.tenant.requireOrgId()
    // An assignee or team that cannot be used is the request's mistake, said once, not two hundred times.
    if (request.action.kind === "assign") {
      await this.tickets.checkAssignment(request.action.assigneeMembershipId, request.action.teamId)
    }
    // Two hundred writes is the most one member starts at a time; the route's throttle bounds how often.
    const lease = `bulk:running:${actor.membershipId}`
    if ((await this.redis.client.set(lease, request.operationId, "EX", RUN_LEASE_SECONDS, "NX")) !== "OK") {
      throw new ConflictProblem("One of your bulk actions is still running; wait for it to finish")
    }
    try {
      return await this.runAll(orgId, actor.membershipId, request)
    } finally {
      await this.redis.client.del(lease)
    }
  }

  private async runAll(orgId: string, membershipId: string, request: BulkTicketRequest): Promise<BulkTicketResult> {
    const total = request.tickets.length
    const results: BulkTicketResult["results"] = []
    for (const [index, ticket] of request.tickets.entries()) {
      results.push({ ticketId: ticket.id, ...(await this.one(orgId, ticket, request.action)) })
      const processed = index + 1
      if (processed % PROGRESS_EVERY === 0 || processed === total) {
        await this.bus.publish(orgId, {
          kind: "bulk-progress",
          membershipId,
          event: { operationId: request.operationId, processed, total },
        })
      }
    }
    return { total, done: results.filter((r) => r.outcome === "done").length, results }
  }

  private async one(
    orgId: string,
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
      if (error instanceof StaleWriteProblem) return { outcome: "conflict", detail: "Someone changed it since you loaded it" }
      if (error instanceof NotFoundProblem) return { outcome: "not-found", detail: null }
      if (error instanceof ValidationProblem) {
        // The field's own reason, as the single action's 400 would carry it, not the generic title.
        return { outcome: "refused", detail: error.errors?.map((e) => e.message).join("; ") ?? error.message }
      }
      if (error instanceof ProblemException) return { outcome: "refused", detail: error.message }
      // A fault, not an answer. This ticket's own transaction rolled back; the ones before it stand, and the
      // agent is told which, rather than losing every result to a 500.
      this.logger.error({ msg: "bulk action failed on a ticket", orgId, ticketId: ticket.id, error: String(error) })
      return { outcome: "failed", detail: "Something went wrong on our side; this ticket was left as it was" }
    }
  }
}
