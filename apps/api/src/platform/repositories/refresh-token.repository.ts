import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type RefreshTokenRecord = {
  id: string
  userId: string
  /** `null` is a `pg_id` — the tenant-less identity (ADR-0031). */
  orgId: string | null
  expiresAt: Date
  revokedAt: Date | null
  /** Set when this token was rotated. Presenting it again is reuse (ADR-0004). */
  replacedById: string | null
}

export type NewRefreshToken = {
  userId: string
  orgId: string | null
  tokenHash: string
  expiresAt: Date
  userAgent: string | null
  ip: string | null
}

const RECORD = {
  id: true,
  userId: true,
  orgId: true,
  expiresAt: true,
  revokedAt: true,
  replacedById: true,
} as const

/**
 * Refresh tokens and `pg_id`, platform class. Rows form a chain through
 * `replacedById`; a chain is revoked as a unit when any rotated member of it
 * is presented again, which is the token-theft signal (ADR-0004).
 */
@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(token: NewRefreshToken): Promise<RefreshTokenRecord> {
    return this.prisma.db.refreshToken.create({ data: token, select: RECORD })
  }

  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.db.refreshToken.findUnique({ where: { tokenHash }, select: RECORD })
  }

  /** The old token is marked replaced and the new one created, atomically. */
  async rotate(previousId: string, next: NewRefreshToken, at: Date): Promise<RefreshTokenRecord> {
    return this.prisma.transaction(async (tx) => {
      const created = await tx.refreshToken.create({ data: next, select: RECORD })
      await tx.refreshToken.update({
        where: { id: previousId },
        data: { replacedById: created.id, revokedAt: at },
      })
      return created
    })
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.prisma.db.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    })
  }

  /**
   * Revokes every descendant of a token, following `replacedById`. Bounded:
   * a chain longer than this is itself a bug, and the loop must terminate.
   */
  async revokeChainFrom(id: string, at: Date): Promise<number> {
    let current: string | null = id
    let revoked = 0
    for (let step = 0; step < 1_000 && current !== null; step += 1) {
      const row: { replacedById: string | null } | null = await this.prisma.db.refreshToken.findUnique({
        where: { id: current },
        select: { replacedById: true },
      })
      await this.revoke(current, at)
      revoked += 1
      current = row?.replacedById ?? null
    }
    return revoked
  }

  /** "Log out everywhere": every live token of the user, in every workspace, and `pg_id`. */
  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    })
    return result.count
  }
}
