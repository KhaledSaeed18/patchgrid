import { Injectable } from "@nestjs/common"
import type { ApiTokenRole, MembershipKind, MembershipStatus, Role, TokenScope } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

export type ApiTokenRow = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  membershipId: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  membership: { role: Role; status: MembershipStatus }
  createdBy: { id: string; displayName: string }
}

/** What the bearer path needs to decide, on every request (ADR-0042). */
export type ApiTokenCredential = {
  id: string
  tokenHash: string
  scopes: string[]
  membershipId: string
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  membership: { role: Role; status: MembershipStatus; kind: MembershipKind }
}

const ROW = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  membershipId: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  membership: { select: { role: true, status: true } },
  createdBy: { select: { id: true, displayName: true } },
} satisfies Prisma.ApiTokenSelect

/**
 * `ApiToken` and the service account each one acts as (ADR-0021, ADR-0042).
 * Tenant-owned; every method takes the org. A revocation is a conditional
 * update, so two admins revoking at once produce one audit row.
 */
@Injectable()
export class ApiTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The service account and its token, together. Must run inside `transaction()`. */
  async create(
    orgId: string,
    token: {
      name: string
      role: ApiTokenRole
      prefix: string
      tokenHash: string
      scopes: TokenScope[]
      createdByMembershipId: string
      expiresAt: Date | null
    },
    at: Date,
  ): Promise<string> {
    const membership = await this.prisma.db.membership.create({
      data: {
        orgId,
        kind: "SERVICE_ACCOUNT",
        role: token.role,
        displayName: token.name,
        joinedAt: at,
      },
      select: { id: true },
    })
    const row = await this.prisma.db.apiToken.create({
      data: {
        orgId,
        name: token.name,
        prefix: token.prefix,
        tokenHash: token.tokenHash,
        scopes: token.scopes,
        membershipId: membership.id,
        createdByMembershipId: token.createdByMembershipId,
        expiresAt: token.expiresAt,
        createdAt: at,
      },
      select: { id: true },
    })
    return row.id
  }

  find(orgId: string, id: string): Promise<ApiTokenRow | null> {
    return this.prisma.db.apiToken.findUnique({
      where: { orgId_id: { orgId, id } },
      select: ROW,
    })
  }

  /** Newest first. A workspace has a handful; revoked ones stay listed, as history. */
  list(orgId: string, limit = 100): Promise<ApiTokenRow[]> {
    return this.prisma.db.apiToken.findMany({
      where: { orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: ROW,
    })
  }

  credential(orgId: string, prefix: string): Promise<ApiTokenCredential | null> {
    return this.prisma.db.apiToken.findUnique({
      where: { orgId_prefix: { orgId, prefix } },
      select: {
        id: true,
        tokenHash: true,
        scopes: true,
        membershipId: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        membership: { select: { role: true, status: true, kind: true } },
      },
    })
  }

  /** At most one write a minute per token, whoever races (ADR-0042). */
  async markUsed(orgId: string, id: string, at: Date, notSince: Date): Promise<void> {
    await this.prisma.db.apiToken.updateMany({
      where: {
        orgId,
        id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: notSince } }],
      },
      data: { lastUsedAt: at },
    })
  }

  /** Revokes the token and disables its service account. Must run inside `transaction()`. */
  async revoke(orgId: string, id: string, by: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.apiToken.updateMany({
      where: { orgId, id, revokedAt: null },
      data: { revokedAt: at, revokedByMembershipId: by },
    })
    if (count !== 1) return false
    const token = await this.prisma.db.apiToken.findUniqueOrThrow({
      where: { orgId_id: { orgId, id } },
      select: { membershipId: true },
    })
    await this.prisma.db.membership.update({
      where: { orgId_id: { orgId, id: token.membershipId } },
      data: { status: "DISABLED" },
    })
    return true
  }

  /** Live tokens lapsing before `by` that nobody has been warned about — the sweep's work. */
  expiringUnwarned(
    orgId: string,
    now: Date,
    by: Date,
  ): Promise<
    {
      id: string
      name: string
      prefix: string
      expiresAt: Date | null
      createdByMembershipId: string
    }[]
  > {
    return this.prisma.db.apiToken.findMany({
      where: {
        orgId,
        revokedAt: null,
        expiryWarnedAt: null,
        expiresAt: { gt: now, lte: by },
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        expiresAt: true,
        createdByMembershipId: true,
      },
    })
  }

  async markWarned(orgId: string, id: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.db.apiToken.updateMany({
      where: { orgId, id, expiryWarnedAt: null },
      data: { expiryWarnedAt: at },
    })
    return count === 1
  }

  /**
   * Who hears that a token is about to lapse: whoever created it, while they
   * are still an active admin or owner; otherwise every active owner.
   */
  async warningAddresses(orgId: string, createdByMembershipId: string): Promise<string[]> {
    const creator = await this.prisma.db.membership.findFirst({
      where: {
        orgId,
        id: createdByMembershipId,
        kind: "HUMAN",
        status: "ACTIVE",
        role: { in: ["ADMIN", "OWNER"] },
      },
      select: { user: { select: { email: true } } },
    })
    if (creator?.user != null) return [creator.user.email]
    const owners = await this.prisma.db.membership.findMany({
      where: { orgId, kind: "HUMAN", status: "ACTIVE", role: "OWNER" },
      select: { user: { select: { email: true } } },
    })
    return owners.flatMap((o) => (o.user === null ? [] : [o.user.email]))
  }
}
