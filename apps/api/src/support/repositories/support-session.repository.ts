import { Injectable } from "@nestjs/common"
import type { SupportEndReason } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

export type SupportSessionRow = {
  id: string
  platformAdminId: string
  reason: string
  requestedAt: Date
  grantedAt: Date | null
  declinedAt: Date | null
  expiresAt: Date | null
  firstUsedAt: Date | null
  endedAt: Date | null
  endReason: SupportEndReason | null
  platformAdmin: { user: { name: string } }
}

const ROW = {
  id: true,
  platformAdminId: true,
  reason: true,
  requestedAt: true,
  grantedAt: true,
  declinedAt: true,
  expiresAt: true,
  firstUsedAt: true,
  endedAt: true,
  endReason: true,
  platformAdmin: { select: { user: { select: { name: true } } } },
} satisfies Prisma.SupportSessionSelect

/**
 * `SupportSession` (ADR-0020, ADR-0041). Tenant-owned; every method takes the
 * org. Each decision is a conditional update, so a grant racing a decline,
 * or a revoke racing the expiry sweep, has exactly one winner.
 */
@Injectable()
export class SupportSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async request(orgId: string, platformAdminId: string, reason: string): Promise<string> {
    const row = await this.prisma.db.supportSession.create({ data: { orgId, platformAdminId, reason }, select: { id: true } })
    return row.id
  }

  find(orgId: string, id: string): Promise<SupportSessionRow | null> {
    return this.prisma.db.supportSession.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  /** Newest first; a workspace has few. */
  list(orgId: string, limit = 50): Promise<SupportSessionRow[]> {
    return this.prisma.db.supportSession.findMany({ where: { orgId }, orderBy: [{ requestedAt: "desc" }, { id: "desc" }], take: limit, select: ROW })
  }

  /** The session running now, if any — the banner's answer. */
  running(orgId: string, now: Date): Promise<SupportSessionRow | null> {
    return this.prisma.db.supportSession.findFirst({
      where: { orgId, grantedAt: { not: null }, endedAt: null, expiresAt: { gt: now } },
      orderBy: { expiresAt: "desc" },
      select: ROW,
    })
  }

  /** Only an undecided request. */
  async grant(orgId: string, id: string, membershipId: string, grantedAt: Date, expiresAt: Date): Promise<boolean> {
    const { count } = await this.prisma.db.supportSession.updateMany({
      where: { orgId, id, grantedAt: null, declinedAt: null },
      data: { decidedByMembershipId: membershipId, grantedAt, expiresAt },
    })
    return count === 1
  }

  async decline(orgId: string, id: string, membershipId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.supportSession.updateMany({
      where: { orgId, id, grantedAt: null, declinedAt: null },
      data: { decidedByMembershipId: membershipId, declinedAt: at },
    })
    return count === 1
  }

  /** Ends a granted session that has not ended. `revokedBy` only for a revocation. */
  async end(orgId: string, id: string, reason: SupportEndReason, at: Date, revokedBy: string | null = null): Promise<boolean> {
    const { count } = await this.prisma.db.supportSession.updateMany({
      where: { orgId, id, grantedAt: { not: null }, endedAt: null },
      data: { endedAt: at, endReason: reason, revokedByMembershipId: revokedBy },
    })
    return count === 1
  }

  /** `true` exactly once: the request that used the session first. */
  async markFirstUse(orgId: string, id: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.supportSession.updateMany({ where: { orgId, id, firstUsedAt: null }, data: { firstUsedAt: at } })
    return count === 1
  }

  /** Granted, still running by the row, but past its expiry — the sweep's work. */
  async expiredRunning(orgId: string, now: Date): Promise<{ id: string; platformAdminId: string }[]> {
    return this.prisma.db.supportSession.findMany({
      where: { orgId, grantedAt: { not: null }, endedAt: null, expiresAt: { lte: now } },
      select: { id: true, platformAdminId: true },
    })
  }

  /** The workspace's active owners and their addresses — who is told about support (ADR-0020). */
  async ownerAddresses(orgId: string): Promise<{ email: string; name: string }[]> {
    const rows = await this.prisma.db.membership.findMany({
      where: { orgId, role: "OWNER", status: "ACTIVE", kind: "HUMAN" },
      select: { displayName: true, user: { select: { email: true } } },
    })
    return rows.flatMap((r) => (r.user === null ? [] : [{ email: r.user.email, name: r.displayName }]))
  }
}
