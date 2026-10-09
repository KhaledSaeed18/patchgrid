import { Injectable } from "@nestjs/common"
import type { Watcher } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
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
    await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
      const self = membershipId === actor.membershipId
      this.permissions.assert(actor, self ? "ticket:watch" : "ticket:watch_others", loaded.subject)
      if (!self) {
        const target = await this.memberships.findById(orgId, membershipId)
        if (target === null || target.status !== "ACTIVE") {
          throw new ValidationProblem([{ path: "membershipId", message: "is not an active member", code: "invalid_watcher" }])
        }
      }
      if (await this.watchers.add(orgId, ticketId, membershipId, actor.membershipId)) {
        await this.audit.record(orgId, [{ action: "WATCHER_ADDED", entityType: "Ticket", entityId: ticketId, diff: { membershipId } }])
      }
    })
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
    return this.list(ticketId)
  }

  private visibility() {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}
