import { Injectable } from "@nestjs/common"
import type { WorkspaceSummary } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * The org picker's one question: which workspaces may this user enter?
 * Derived, display-only, never authorization (ADR-0022) — which is why the
 * columns are named `roleForDisplay` / `statusForDisplay` and why this class
 * exposes exactly one read.
 */
@Injectable()
export class UserOrgIndexRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.prisma.db.userOrgIndex.findMany({
      where: { userId },
      orderBy: { orgName: "asc" },
      select: {
        orgId: true,
        orgSlug: true,
        orgName: true,
        roleForDisplay: true,
        statusForDisplay: true,
        orgStatus: true,
      },
    })
    return rows.map((row) => ({
      orgId: row.orgId,
      slug: row.orgSlug,
      name: row.orgName,
      role: row.roleForDisplay,
      status: row.statusForDisplay,
      orgStatus: row.orgStatus,
    }))
  }
}
