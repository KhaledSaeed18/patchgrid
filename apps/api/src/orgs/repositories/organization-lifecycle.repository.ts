import { Injectable } from "@nestjs/common"
import type { OrganizationStatus } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type LifecycleRecord = { id: string; name: string; slug: string; status: OrganizationStatus; deletionRequestedAt: Date | null }

/**
 * A workspace's deletion window (ADR-0043). The organization and the picker's
 * projection are platform class and move together; each move is conditional
 * on the status it starts from, so a cancel racing the purge, or two owners
 * racing each other, has exactly one winner.
 */
@Injectable()
export class OrganizationLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(orgId: string): Promise<LifecycleRecord | null> {
    return this.prisma.db.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, status: true, deletionRequestedAt: true },
    })
  }

  /** `ACTIVE` → `PENDING_DELETION`, mirrored into the picker. Must run inside `transaction()`. */
  async requestDeletion(orgId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.organization.updateMany({
      where: { id: orgId, status: "ACTIVE" },
      data: { status: "PENDING_DELETION", deletionRequestedAt: at },
    })
    if (count === 1)
      await this.prisma.db.userOrgIndex.updateMany({
        where: { orgId },
        data: { orgStatus: "PENDING_DELETION", orgDeletionRequestedAt: at },
      })
    return count === 1
  }

  /** `PENDING_DELETION` → `ACTIVE`, as it was. Must run inside `transaction()`. */
  async cancelDeletion(orgId: string): Promise<boolean> {
    const { count } = await this.prisma.db.organization.updateMany({
      where: { id: orgId, status: "PENDING_DELETION" },
      data: { status: "ACTIVE", deletionRequestedAt: null },
    })
    if (count === 1)
      await this.prisma.db.userOrgIndex.updateMany({ where: { orgId }, data: { orgStatus: "ACTIVE", orgDeletionRequestedAt: null } })
    return count === 1
  }

  /** Inside the tenant: every membership, so each one's sessions can be ended. */
  async membershipIds(orgId: string): Promise<string[]> {
    const rows = await this.prisma.db.membership.findMany({ where: { orgId }, select: { id: true } })
    return rows.map((r) => r.id)
  }

  /** Inside the tenant: the active owners and admins, who hear about a deletion. */
  async stewardAddresses(orgId: string): Promise<string[]> {
    const rows = await this.prisma.db.membership.findMany({
      where: { orgId, kind: "HUMAN", status: "ACTIVE", role: { in: ["OWNER", "ADMIN"] } },
      select: { user: { select: { email: true } } },
    })
    return rows.flatMap((r) => (r.user === null ? [] : [r.user.email]))
  }
}
