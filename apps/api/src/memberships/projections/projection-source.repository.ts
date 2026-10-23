import { Injectable } from "@nestjs/common"

import type { TokenIndexRow } from "../../platform/repositories/api-token-index.repository"
import { PrismaService } from "../../prisma/prisma.service"
import type { ProjectionSource } from "./reconcile"

/**
 * What one org's projections derive from (ADR-0022), read in tenant context:
 * the organization and its human memberships for `UserOrgIndex`, its tokens
 * for `ApiTokenIndex`. Reads only — the projections' own repositories are
 * the only writers of their rows.
 */
@Injectable()
export class ProjectionSourceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async people(orgId: string): Promise<ProjectionSource | null> {
    const org = await this.prisma.db.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, name: true, status: true, deletionRequestedAt: true },
    })
    if (org === null) return null
    const members = await this.prisma.db.membership.findMany({
      // An erased membership has no picker row to keep, ever (ADR-0044).
      where: { orgId, kind: "HUMAN", userId: { not: null }, anonymisedAt: null },
      select: { userId: true, role: true, status: true },
    })
    return { org, members: members.flatMap((m) => (m.userId === null ? [] : [{ userId: m.userId, role: m.role, status: m.status }])) }
  }

  /** The org's tokens, as the index should mirror them. */
  tokens(orgId: string): Promise<TokenIndexRow[]> {
    return this.prisma.db.apiToken.findMany({ where: { orgId }, select: { prefix: true, revokedAt: true } })
  }
}
