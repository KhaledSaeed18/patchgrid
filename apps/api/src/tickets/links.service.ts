import { Injectable } from "@nestjs/common"
import { type CreateLinkRequest, formatTicketNumber, type TicketLink } from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { TicketPulse } from "../notifications/live/ticket-pulse"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { canonicalLink, readFrom } from "./domain/links"
import { LinkRepository, type LinkRow } from "./repositories/link.repository"
import { TicketAccess } from "./ticket-access"

/**
 * Links between tickets (DOMAIN.md §1): stored once in their canonical
 * direction, read from both ends. A link is a fact about two tickets, so
 * both must be ones the actor can read, and adding or removing one needs
 * `ticket:link` on both. A link whose other end the actor cannot read is
 * not shown at all — not even that it exists.
 */
@Injectable()
export class LinksService {
  constructor(
    private readonly links: LinkRepository,
    private readonly access: TicketAccess,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pulse: TicketPulse,
  ) {}

  async list(ticketId: string): Promise<TicketLink[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      await this.access.load(orgId, ticketId, actor, this.visibility())
      return this.visibleLinks(orgId, ticketId, actor)
    })
  }

  async add(ticketId: string, request: CreateLinkRequest): Promise<TicketLink[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const otherId = await this.prisma.transaction(async () => {
      const self = await this.access.load(orgId, ticketId, actor, this.visibility())
      this.permissions.assert(actor, "ticket:link", self.subject)
      // A duplicate points at the survivor of whatever it duplicates, so chains — and cycles — cannot form.
      const target = request.kind === "DUPLICATE_OF" ? await this.links.survivorOf(orgId, request.ticketId) : request.ticketId
      if (request.kind === "DUPLICATE_OF" && target === ticketId) throw new ConflictProblem("That ticket is already a duplicate of this one")
      const [other] = await this.access.loadVisible(orgId, [target], actor, this.visibility())
      if (other === undefined) throw new NotFoundProblem("No such ticket to link")
      this.permissions.assert(actor, "ticket:link", other.subject)

      const made = canonicalLink(request.kind, { id: ticketId, type: self.row.type }, { id: other.row.id, type: other.row.type })
      if (!made.ok) throw new ValidationProblem([{ path: "kind", message: made.reason, code: "invalid_link" }])
      if (!(await this.links.create(orgId, made.link, actor.membershipId))) throw new ConflictProblem("These tickets are already linked that way")
      await this.audit.record(orgId, [{ action: "TICKET_LINKED", entityType: "Ticket", entityId: ticketId, diff: { ...made.link } }])
      return other.row.id
    })
    await this.pulse.changed(orgId, ticketId)
    await this.pulse.changed(orgId, otherId)
    return this.list(ticketId)
  }

  async remove(ticketId: string, linkId: string): Promise<TicketLink[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const otherId = await this.prisma.transaction(async () => {
      const self = await this.access.load(orgId, ticketId, actor, this.visibility())
      const link = await this.links.find(orgId, linkId)
      if (link === null || (link.fromTicketId !== ticketId && link.toTicketId !== ticketId)) throw new NotFoundProblem()
      const otherId = link.fromTicketId === ticketId ? link.toTicketId : link.fromTicketId
      const [other] = await this.access.loadVisible(orgId, [otherId], actor, this.visibility())
      // A link the actor was never shown is one they cannot remove.
      if (other === undefined) throw new NotFoundProblem()
      this.permissions.assert(actor, "ticket:link", self.subject)
      this.permissions.assert(actor, "ticket:link", other.subject)
      if (!(await this.links.remove(orgId, linkId))) throw new NotFoundProblem()
      const { fromTicketId, toTicketId, relation } = link
      await this.audit.record(orgId, [{ action: "TICKET_UNLINKED", entityType: "Ticket", entityId: ticketId, diff: { fromTicketId, toTicketId, relation } }])
      return otherId
    })
    await this.pulse.changed(orgId, ticketId)
    await this.pulse.changed(orgId, otherId)
    return this.list(ticketId)
  }

  /** This ticket's links whose other end the actor may read, as read from this ticket. */
  private async visibleLinks(orgId: string, ticketId: string, actor: TenantActor): Promise<TicketLink[]> {
    const rows = await this.links.list(orgId, ticketId)
    const others = rows.map((r) => otherEnd(r, ticketId).id)
    const visible = new Set((await this.access.loadVisible(orgId, others, actor, this.visibility())).map((t) => t.row.id))
    return rows.flatMap((row) => {
      const other = otherEnd(row, ticketId)
      if (!visible.has(other.id)) return []
      return [
        {
          id: row.id,
          kind: readFrom(row, ticketId),
          ticket: { id: other.id, number: formatTicketNumber(other.type, other.number), type: other.type, title: other.title, status: other.status },
          createdAt: row.createdAt.toISOString(),
        },
      ]
    })
  }

  private visibility() {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}

function otherEnd(row: LinkRow, ticketId: string) {
  return row.fromTicketId === ticketId ? row.to : row.from
}
