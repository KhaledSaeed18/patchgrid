import { Injectable } from "@nestjs/common"
import { type MembershipStatus, type OrganizationStatus, purgeDateFor, type Role, type WorkspaceSummary } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/** One org's picker row, as the reconcile compares it (ADR-0022). */
export type OrgIndexRow = {
  userId: string
  roleForDisplay: Role
  statusForDisplay: MembershipStatus
  orgSlug: string
  orgName: string
  orgStatus: OrganizationStatus
  orgDeletionRequestedAt: Date | null
}

const ORG_ROW = {
  userId: true,
  roleForDisplay: true,
  statusForDisplay: true,
  orgSlug: true,
  orgName: true,
  orgStatus: true,
  orgDeletionRequestedAt: true,
} as const

/**
 * The org picker's one question: which workspaces may this user enter?
 * Derived, display-only, never authorization (ADR-0022) — which is why the
 * columns are named `roleForDisplay` / `statusForDisplay` and why this class
 * exposes exactly one read. The writes keep it in step with `Membership`, in
 * the same transaction as the change they mirror; a drift is a bug, and the
 * nightly reconcile job exists to find one — through the per-org methods
 * at the end, a fixed number of statements whatever the size of the org.
 */
@Injectable()
export class UserOrgIndexRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.prisma.db.userOrgIndex.findMany({
      // A removed membership keeps its row, for erasure to find; the picker never shows it (ADR-0044).
      where: { userId, statusForDisplay: { not: "REMOVED" } },
      orderBy: { orgName: "asc" },
      select: {
        orgId: true,
        orgSlug: true,
        orgName: true,
        roleForDisplay: true,
        statusForDisplay: true,
        orgStatus: true,
        orgDeletionRequestedAt: true,
      },
    })
    return rows.map((row) => ({
      orgId: row.orgId,
      slug: row.orgSlug,
      name: row.orgName,
      role: row.roleForDisplay,
      status: row.statusForDisplay,
      orgStatus: row.orgStatus,
      purgeAt: row.orgDeletionRequestedAt === null ? null : purgeDateFor(row.orgDeletionRequestedAt).toISOString(),
    }))
  }

  async upsert(row: {
    userId: string
    orgId: string
    role: Role
    status: MembershipStatus
    orgSlug: string
    orgName: string
    orgStatus: OrganizationStatus
  }): Promise<void> {
    const data = {
      roleForDisplay: row.role,
      statusForDisplay: row.status,
      orgSlug: row.orgSlug,
      orgName: row.orgName,
      orgStatus: row.orgStatus,
    }
    await this.prisma.db.userOrgIndex.upsert({
      where: { userId_orgId: { userId: row.userId, orgId: row.orgId } },
      create: { userId: row.userId, orgId: row.orgId, ...data },
      update: data,
    })
  }

  async mirror(userId: string, orgId: string, change: { role?: Role; status?: MembershipStatus }): Promise<void> {
    await this.prisma.db.userOrgIndex.updateMany({
      where: { userId, orgId },
      data: {
        ...(change.role === undefined ? {} : { roleForDisplay: change.role }),
        ...(change.status === undefined ? {} : { statusForDisplay: change.status }),
      },
    })
  }

  /**
   * A removed member loses the workspace from the picker (ADR-0033); the row
   * stays, marked, so erasure can still find every workspace a person was in
   * and take their name out of it (ADR-0044).
   */
  async markRemoved(userId: string, orgId: string): Promise<void> {
    await this.prisma.db.userOrgIndex.updateMany({ where: { userId, orgId }, data: { statusForDisplay: "REMOVED" } })
  }

  /** Every workspace this account has a membership in, removed ones included — erasure's list. */
  async allOrgIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.db.userOrgIndex.findMany({ where: { userId }, select: { orgId: true } })
    return rows.map((r) => r.orgId)
  }

  /** The account is gone (ADR-0044): its picker goes with it. */
  async removeAllForUser(userId: string): Promise<void> {
    await this.prisma.db.userOrgIndex.deleteMany({ where: { userId } })
  }

  /** One org's rows, for the reconcile to compare against `Membership`. */
  rowsForOrg(orgId: string): Promise<OrgIndexRow[]> {
    return this.prisma.db.userOrgIndex.findMany({ where: { orgId }, select: ORG_ROW })
  }

  async createForOrg(orgId: string, rows: readonly OrgIndexRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.prisma.db.userOrgIndex.createMany({ data: rows.map((row) => ({ orgId, ...row })), skipDuplicates: true })
  }

  /** Rewrites drifted rows: out and back in, two statements however many there are. */
  async replaceForOrg(orgId: string, rows: readonly OrgIndexRow[]): Promise<void> {
    await this.removeForOrg(
      orgId,
      rows.map((row) => row.userId),
    )
    await this.createForOrg(orgId, rows)
  }

  async removeForOrg(orgId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return
    await this.prisma.db.userOrgIndex.deleteMany({ where: { orgId, userId: { in: [...userIds] } } })
  }
}
