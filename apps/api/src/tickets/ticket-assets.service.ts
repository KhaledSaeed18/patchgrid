import { Injectable } from "@nestjs/common"
import type { AgentVisibility } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { AssetsService } from "../assets/assets.service"
import { AssetRepository } from "../assets/repositories/asset.repository"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { NotFoundProblem } from "../common/problems/problem.exception"
import { TicketPulse } from "../notifications/live/ticket-pulse"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TicketAccess } from "./ticket-access"

/**
 * The assets a ticket is about (DOMAIN.md §9.3). Naming one is `ticket:link`
 * on the ticket, and the asset must be one the actor can open; taking one
 * off is `ticket:link` alone — a link already on the ticket is part of it.
 * Naming one twice is the same request twice.
 */
@Injectable()
export class TicketAssetsService {
  constructor(
    private readonly links: AssetRepository,
    private readonly assets: AssetsService,
    private readonly access: TicketAccess,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pulse: TicketPulse,
  ) {}

  async link(ticketId: string, assetId: string): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const added = await this.prisma.transaction(async () => {
      const ticket = await this.access.load(orgId, ticketId, actor, this.visibility())
      this.permissions.assert(actor, "ticket:link", ticket.subject)
      const [asset] = await this.assets.visible(orgId, actor, [assetId])
      if (asset === undefined) throw new NotFoundProblem("No such asset")
      // Under the asset's lock, so a delete that has counted no tickets cannot cross a link.
      await this.links.lock(orgId, assetId)
      if (!(await this.links.link(orgId, ticketId, assetId))) return false
      await this.audit.record(orgId, [{ action: "TICKET_ASSET_LINKED", entityType: "Ticket", entityId: ticketId, diff: { assetId } }])
      return true
    })
    if (added) await this.pulse.changed(orgId, ticketId)
  }

  async unlink(ticketId: string, assetId: string): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const removed = await this.prisma.transaction(async () => {
      const ticket = await this.access.load(orgId, ticketId, actor, this.visibility())
      if (!ticket.row.assets.some((a) => a.id === assetId)) throw new NotFoundProblem()
      this.permissions.assert(actor, "ticket:link", ticket.subject)
      if (!(await this.links.unlink(orgId, ticketId, assetId))) return false
      await this.audit.record(orgId, [{ action: "TICKET_ASSET_UNLINKED", entityType: "Ticket", entityId: ticketId, diff: { assetId } }])
      return true
    })
    if (removed) await this.pulse.changed(orgId, ticketId)
  }

  private visibility(): AgentVisibility {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}
