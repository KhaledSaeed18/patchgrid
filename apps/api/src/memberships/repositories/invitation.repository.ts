import { Injectable } from "@nestjs/common"
import type { Role } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type InvitationRecord = {
  id: string
  orgId: string
  email: string
  role: Role
  teamId: string | null
  invitedByMembershipId: string
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

const RECORD = {
  id: true,
  orgId: true,
  email: true,
  role: true,
  teamId: true,
  invitedByMembershipId: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
} as const

const pending = (now: Date) => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: now } })

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    orgId: string,
    data: {
      email: string
      role: Role
      teamId: string | null
      tokenHash: string
      expiresAt: Date
      invitedByMembershipId: string
    },
  ): Promise<InvitationRecord> {
    return this.prisma.db.invitation.create({ data: { orgId, ...data }, select: RECORD })
  }

  listPending(orgId: string, now: Date): Promise<InvitationRecord[]> {
    return this.prisma.db.invitation.findMany({
      where: { orgId, ...pending(now) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: RECORD,
    })
  }

  findByTokenHash(orgId: string, tokenHash: string): Promise<InvitationRecord | null> {
    return this.prisma.db.invitation.findUnique({ where: { orgId_tokenHash: { orgId, tokenHash } }, select: RECORD })
  }

  /** Re-inviting an address replaces its outstanding invitation (ADR-0033). Returns the ids revoked. */
  async revokePendingFor(orgId: string, email: string, now: Date): Promise<string[]> {
    const outstanding = await this.prisma.db.invitation.findMany({
      where: { orgId, email, ...pending(now) },
      select: { id: true },
    })
    if (outstanding.length === 0) return []
    await this.prisma.db.invitation.updateMany({
      where: { orgId, id: { in: outstanding.map((i) => i.id) } },
      data: { revokedAt: now },
    })
    return outstanding.map((i) => i.id)
  }

  /** `true` only if THIS call revoked a pending invitation. */
  async revoke(orgId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.invitation.updateMany({
      where: { orgId, id, ...pending(now) },
      data: { revokedAt: now },
    })
    return count === 1
  }

  /**
   * Burns the invitation. Conditional, so two acceptances racing on one token
   * cannot both win: the loser's update matches no row.
   */
  async consume(orgId: string, id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.invitation.updateMany({
      where: { orgId, id, ...pending(now) },
      data: { acceptedAt: now },
    })
    return count === 1
  }
}
