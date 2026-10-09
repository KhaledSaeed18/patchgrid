import { Injectable } from "@nestjs/common"
import type { AuditEntry } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { OrgAuditService } from "../audit/org-audit.service"
import { PermissionService } from "../authz/permission.service"
import { NotFoundProblem } from "../common/problems/problem.exception"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TicketAccess } from "./ticket-access"

/** A ticket's own audit trail, oldest first, for agents in scope and admins (RBAC.md §6). */
@Injectable()
export class TicketAuditService {
  constructor(
    private readonly access: TicketAccess,
    private readonly audit: OrgAuditService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
  ) {}

  async trail(ticketId: string): Promise<AuditEntry[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    const loaded = await this.access.load(orgId, ticketId, actor, org.agentVisibility)
    this.permissions.assertVisible(actor, "ticket:read_audit", loaded.subject)
    return this.audit.forEntity(orgId, "Ticket", ticketId)
  }
}
