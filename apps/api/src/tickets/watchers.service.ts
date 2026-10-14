import { Injectable } from "@nestjs/common"
import type { Watcher } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { type Clock, InjectClock } from "../common/clock/clock"
import { TicketPulse } from "../notifications/live/ticket-pulse"
import { Notifier } from "../notifications/notify"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { WatcherRepository } from "./repositories/watcher.repository"
import { TicketAccess } from "./ticket-access"

/**
 * Watchers (RBAC.md §5): access and notifications that are not role-derived.
 * Anyone who can read a ticket may watch it; an agent may add someone else.
 * The requester and the current assignee are implicit — listed, never rows,
 * never removable.
 */
@Injectable()
export class WatchersService {
  constructor(
    private readonly watchers: WatcherRepository,
    private readonly access: TicketAccess,
    private readonly memberships: MembershipRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly pulse: TicketPulse,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(ticketId: string): Promise<Watcher[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const { row } = await this.access.load(orgId, ticketId, actor, this.visibility())
    const implicit: Watcher[] = [
      { membershipId: row.requester.id, displayName: row.requester.displayName, implicit: true },
      ...(row.assignee === null || row.assignee.id === row.requester.id
        ? []
        : [{ membershipId: row.assignee.id, displayName: row.assignee.displayName, implicit: true }]),
    ]
    const ids = new Set(implicit.map((w) => w.membershipId))
    const explicit = (await this.watchers.list(orgId, ticketId))
      .filter((w) => !ids.has(w.membershipId))
      .map((w) => ({ ...w, implicit: false }))
    return [...implicit, ...explicit]
  }

  async add(ticketId: string, membershipId: string): Promise<Watcher[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const added = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
      const self = membershipId === actor.membershipId
      this.permissions.assert(actor, self ? "ticket:watch" : "ticket:watch_others", loaded.subject)
      // A watcher is someone to tell; a service account — a token watching itself
      // included — has no one behind it (ADR-0042).
      if (!(self && actor.kind === "member")) {
        const target = await this.memberships.findById(orgId, membershipId)
        if (target === null || target.status !== "ACTIVE" || target.kind !== "HUMAN") {
          throw new ValidationProblem([{ path: "membershipId", message: "is not an active person in this workspace", code: "invalid_watcher" }])
        }
      }
      if (!(await this.watchers.add(orgId, ticketId, membershipId, actor.membershipId))) return false
      await this.audit.record(orgId, [{ action: "WATCHER_ADDED", entityType: "Ticket", entityId: ticketId, diff: { membershipId } }])
      return true
    })
    if (added) {
      // Watching yourself is not news; `deliveriesFor` drops the actor.
      await this.notifier.notify(
        orgId,
        { kind: "watcher-added", ticketId, actorMembershipId: actor.membershipId, membershipId },
        ticketId,
        `watch-${membershipId}-${String(this.clock.now().getTime())}`,
      )
      await this.pulse.changed(orgId, ticketId)
    }
    return this.list(ticketId)
  }

  async remove(ticketId: string, membershipId: string): Promise<Watcher[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
      const self = membershipId === actor.membershipId
      this.permissions.assert(actor, self ? "ticket:watch" : "ticket:watch_others", loaded.subject)
      if (membershipId === loaded.row.requesterMembershipId || membershipId === loaded.row.assigneeMembershipId) {
        throw new ConflictProblem("The requester and the assignee always watch their ticket")
      }
      if (!(await this.watchers.remove(orgId, ticketId, membershipId))) throw new NotFoundProblem()
      await this.audit.record(orgId, [{ action: "WATCHER_REMOVED", entityType: "Ticket", entityId: ticketId, diff: { membershipId } }])
    })
    await this.pulse.changed(orgId, ticketId)
    // Watching may have been what let the actor see the ticket: stopping is
    // done, and an empty list is the honest answer rather than a 404.
    return membershipId === actor.membershipId ? this.list(ticketId).catch(emptyIfGone) : this.list(ticketId)
  }

  private visibility() {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}

function emptyIfGone(error: unknown): Watcher[] {
  if (error instanceof NotFoundProblem) return []
  throw error
}
