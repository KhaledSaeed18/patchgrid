import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type OneTimeTokenRecord = {
  id: string
  userId: string
  expiresAt: Date
  usedAt: Date | null
}

const RECORD = { id: true, userId: true, expiresAt: true, usedAt: true } as const

/**
 * `EmailVerification` and `PasswordResetToken` have one shape and one life:
 * issued, looked up by hash, used once (ADR-0004, ADR-0031). Issuing a new one
 * voids the ones outstanding, so a mailbox holds at most one live link. Both
 * are platform class — they belong to a `User`, not to a tenant.
 *
 * Two classes rather than one generic: Prisma's delegates do not share a
 * callable type, and twenty duplicated lines beat a cast.
 */
@Injectable()
export class EmailVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  issue(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<OneTimeTokenRecord> {
    return this.prisma.transaction(async (tx) => {
      await tx.emailVerification.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
      return tx.emailVerification.create({ data: { userId, tokenHash, expiresAt }, select: RECORD })
    })
  }

  findByHash(tokenHash: string): Promise<OneTimeTokenRecord | null> {
    return this.prisma.db.emailVerification.findUnique({ where: { tokenHash }, select: RECORD })
  }

  /** False when already used — a replay, not a success. */
  async consume(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.db.emailVerification.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    })
    return result.count === 1
  }
}

@Injectable()
export class PasswordResetTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  issue(userId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<OneTimeTokenRecord> {
    return this.prisma.transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } })
      return tx.passwordResetToken.create({ data: { userId, tokenHash, expiresAt }, select: RECORD })
    })
  }

  findByHash(tokenHash: string): Promise<OneTimeTokenRecord | null> {
    return this.prisma.db.passwordResetToken.findUnique({ where: { tokenHash }, select: RECORD })
  }

  async consume(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.db.passwordResetToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    })
    return result.count === 1
  }
}
