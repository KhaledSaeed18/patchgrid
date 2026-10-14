import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../../prisma/prisma.service"

/** One step of the purge: a tenant table, emptied for one org, in one transaction. */
export type PurgeStep = { table: string; run: (orgId: string) => Promise<number> }

/**
 * Both halves of the purge (ADR-0043). The tenant half runs inside
 * `runAsTenant(orgId)`, where RLS confines every delete to the org whatever
 * the `where` says; the `where` says it anyway. The platform half removes the
 * org's projections and turns its row into a tombstone.
 */
@Injectable()
export class OrgPurgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The org row, locked for the transaction — a cancel or a restore waits on this. */
  async lock(orgId: string): Promise<{ status: string; deletionRequestedAt: Date | null } | null> {
    const rows = await this.prisma.db.$queryRaw<{ status: string; deletionRequestedAt: Date | null }[]>`
      SELECT status::text AS status, "deletionRequestedAt" FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`
    return rows[0] ?? null
  }

  /**
   * Every tenant-owned table, children before parents, so no foreign key ever
   * refuses. A test holds this list to the schema's: a new tenant table that
   * is not here fails the build rather than outliving its workspace.
   */
  readonly steps: readonly PurgeStep[] = [
    this.step("AuditLog", (orgId) => this.prisma.db.auditLog.deleteMany({ where: { orgId } })),
    this.step("Notification", (orgId) => this.prisma.db.notification.deleteMany({ where: { orgId } })),
    this.step("TicketWatcher", (orgId) => this.prisma.db.ticketWatcher.deleteMany({ where: { orgId } })),
    this.step("Attachment", (orgId) => this.prisma.db.attachment.deleteMany({ where: { orgId } })),
    this.step("InboundEmail", (orgId) => this.prisma.db.inboundEmail.deleteMany({ where: { orgId } })),
    this.step("SupportSession", (orgId) => this.prisma.db.supportSession.deleteMany({ where: { orgId } })),
    this.step("ApiToken", (orgId) => this.prisma.db.apiToken.deleteMany({ where: { orgId } })),
    this.step("TicketAsset", (orgId) => this.prisma.db.ticketAsset.deleteMany({ where: { orgId } })),
    this.step("Asset", (orgId) => this.prisma.db.asset.deleteMany({ where: { orgId } })),
    this.step("KnowledgeArticle", (orgId) => this.prisma.db.knowledgeArticle.deleteMany({ where: { orgId } })),
    this.step("TicketLink", (orgId) => this.prisma.db.ticketLink.deleteMany({ where: { orgId } })),
    this.step("ChangeApproval", (orgId) => this.prisma.db.changeApproval.deleteMany({ where: { orgId } })),
    this.step("ProblemDetails", (orgId) => this.prisma.db.problemDetails.deleteMany({ where: { orgId } })),
    this.step("ChangeDetails", (orgId) => this.prisma.db.changeDetails.deleteMany({ where: { orgId } })),
    this.step("Comment", (orgId) => this.prisma.db.comment.deleteMany({ where: { orgId } })),
    this.step("Ticket", (orgId) => this.prisma.db.ticket.deleteMany({ where: { orgId } })),
    this.step("TicketCounter", (orgId) => this.prisma.db.ticketCounter.deleteMany({ where: { orgId } })),
    this.step("SLAPolicy", (orgId) => this.prisma.db.sLAPolicy.deleteMany({ where: { orgId } })),
    this.step("Category", async (orgId) => {
      // Three levels at most (the depth CHECK): deepest first, so no parent goes before its children.
      let removed = 0
      for (const depth of [3, 2, 1]) removed += (await this.prisma.db.category.deleteMany({ where: { orgId, depth } })).count
      return removed
    }),
    this.step("Invitation", (orgId) => this.prisma.db.invitation.deleteMany({ where: { orgId } })),
    this.step("TeamMembership", (orgId) => this.prisma.db.teamMembership.deleteMany({ where: { orgId } })),
    this.step("Membership", async (orgId) => {
      await this.prisma.db.membership.updateMany({ where: { orgId, invitedByMembershipId: { not: null } }, data: { invitedByMembershipId: null } })
      return this.prisma.db.membership.deleteMany({ where: { orgId } })
    }),
    this.step("Team", (orgId) => this.prisma.db.team.deleteMany({ where: { orgId } })),
    this.step("UsageCounter", (orgId) => this.prisma.db.usageCounter.deleteMany({ where: { orgId } })),
  ]

  /**
   * The last step, in one transaction with the status check: the picker's and
   * the token prefixes' projections and the org's refresh tokens go; the row
   * stays, nameless, with its slug — taken for good (ADR-0043).
   */
  async tombstone(orgId: string, at: Date): Promise<boolean> {
    await this.prisma.db.userOrgIndex.deleteMany({ where: { orgId } })
    await this.prisma.db.apiTokenIndex.deleteMany({ where: { orgId } })
    await this.prisma.db.refreshToken.deleteMany({ where: { orgId } })
    const { count } = await this.prisma.db.organization.updateMany({
      where: { id: orgId, status: "PENDING_DELETION" },
      data: { status: "DELETED", deletedAt: at, name: "Deleted workspace", domain: null, domainVerifiedAt: null, allowDomainJoin: false, defaultJoinRole: null },
    })
    return count === 1
  }

  private step(table: string, remove: (orgId: string) => Promise<{ count: number } | number>): PurgeStep {
    return {
      table,
      run: async (orgId) => {
        const result = await remove(orgId)
        return typeof result === "number" ? result : result.count
      },
    }
  }
}
