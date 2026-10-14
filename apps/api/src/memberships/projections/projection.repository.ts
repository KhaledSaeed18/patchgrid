import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"
import type { IndexRow, ProjectionSource, TokenIndexRow } from "./reconcile"

const ROW = {
  userId: true,
  roleForDisplay: true,
  statusForDisplay: true,
  orgSlug: true,
  orgName: true,
  orgStatus: true,
  orgDeletionRequestedAt: true,
} as const

/**
 * Both sides of one org's `UserOrgIndex` projection (ADR-0022): the source —
 * the organization and its memberships, read in tenant context — and the
 * derived rows. Every method takes the org; the reads and the writes are a fixed
 * number of statements whatever the size of the org.
 */
@Injectable()
export class ProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async source(orgId: string): Promise<ProjectionSource | null> {
    const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { slug: true, name: true, status: true, deletionRequestedAt: true } })
    if (org === null) return null
    const members = await this.prisma.db.membership.findMany({
      // An erased membership has no picker row to keep, ever (ADR-0044).
      where: { orgId, kind: "HUMAN", userId: { not: null }, anonymisedAt: null },
      select: { userId: true, role: true, status: true },
    })
    return { org, members: members.flatMap((m) => (m.userId === null ? [] : [{ userId: m.userId, role: m.role, status: m.status }])) }
  }

  async rows(orgId: string): Promise<IndexRow[]> {
    return this.prisma.db.userOrgIndex.findMany({ where: { orgId }, select: ROW })
  }

  async create(orgId: string, rows: readonly IndexRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.prisma.db.userOrgIndex.createMany({ data: rows.map((row) => ({ orgId, ...row })), skipDuplicates: true })
  }

  /** Rewrites drifted rows: out and back in, two statements however many there are. */
  async replace(orgId: string, rows: readonly IndexRow[]): Promise<void> {
    await this.remove(orgId, rows.map((row) => row.userId))
    await this.create(orgId, rows)
  }

  async remove(orgId: string, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return
    await this.prisma.db.userOrgIndex.deleteMany({ where: { orgId, userId: { in: [...userIds] } } })
  }

  /** The org's tokens, as the index should mirror them. */
  tokenSource(orgId: string): Promise<TokenIndexRow[]> {
    return this.prisma.db.apiToken.findMany({ where: { orgId }, select: { prefix: true, revokedAt: true } })
  }

  tokenRows(orgId: string): Promise<TokenIndexRow[]> {
    return this.prisma.db.apiTokenIndex.findMany({ where: { orgId }, select: { prefix: true, revokedAt: true } })
  }

  async writeTokens(orgId: string, plan: { create: readonly TokenIndexRow[]; update: readonly TokenIndexRow[]; remove: readonly string[] }): Promise<void> {
    if (plan.create.length > 0) await this.prisma.db.apiTokenIndex.createMany({ data: plan.create.map((row) => ({ orgId, ...row })), skipDuplicates: true })
    for (const row of plan.update) {
      await this.prisma.db.apiTokenIndex.updateMany({ where: { orgId, prefix: row.prefix }, data: { revokedAt: row.revokedAt } })
    }
    if (plan.remove.length > 0) await this.prisma.db.apiTokenIndex.deleteMany({ where: { orgId, prefix: { in: [...plan.remove] } } })
  }
}
