import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type FactorRecord = { id: string; secretEncrypted: string; confirmedAt: Date | null; lastUsedStep: number | null }

const FACTOR = { id: true, secretEncrypted: true, confirmedAt: true, lastUsedStep: true } as const

/**
 * A person's second factors and recovery codes (ADR-0029). Platform class:
 * they belong to the person, not to any workspace. Every "use" is a
 * conditional update, so two requests racing with one code cannot both win.
 */
@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  confirmed(userId: string): Promise<FactorRecord | null> {
    return this.prisma.db.userMfaFactor.findFirst({ where: { userId, kind: "TOTP", confirmedAt: { not: null } }, select: FACTOR })
  }

  /** The newest unconfirmed factor still inside its hour, if any. */
  pending(userId: string, createdAfter: Date): Promise<FactorRecord | null> {
    return this.prisma.db.userMfaFactor.findFirst({
      where: { userId, kind: "TOTP", confirmedAt: null, createdAt: { gt: createdAfter } },
      orderBy: { createdAt: "desc" },
      select: FACTOR,
    })
  }

  /** A fresh unconfirmed factor; earlier unconfirmed ones go — only the newest QR code works. */
  async startEnrolment(userId: string, secretEncrypted: string, label: string): Promise<void> {
    await this.prisma.db.userMfaFactor.deleteMany({ where: { userId, confirmedAt: null } })
    await this.prisma.db.userMfaFactor.create({ data: { userId, secretEncrypted, label } })
  }

  /** Confirms the factor with its first accepted step, and replaces the recovery codes, together. */
  async confirm(userId: string, factorId: string, step: number, now: Date, recoveryHashes: readonly string[]): Promise<boolean> {
    // Two enrolments confirmed at once: the one-confirmed-factor index lets one win; the other is a refusal, not a 500.
    return this.confirmOnce(userId, factorId, step, now, recoveryHashes).catch((error: unknown) => {
      if (isUniqueViolation(error)) return false
      throw error
    })
  }

  private confirmOnce(userId: string, factorId: string, step: number, now: Date, recoveryHashes: readonly string[]): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      const { count } = await tx.userMfaFactor.updateMany({
        where: { id: factorId, userId, confirmedAt: null },
        data: { confirmedAt: now, lastUsedStep: step, lastUsedAt: now },
      })
      if (count !== 1) return false
      await tx.userMfaRecovery.deleteMany({ where: { userId } })
      await tx.userMfaRecovery.createMany({ data: recoveryHashes.map((codeHash) => ({ userId, codeHash })) })
      return true
    })
  }

  /** Spends a step: only if it is later than the last one, so a replayed code loses the race. */
  async spendStep(factorId: string, step: number, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.userMfaFactor.updateMany({
      where: { id: factorId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step, lastUsedAt: now },
    })
    return count === 1
  }

  unusedRecoveryCodes(userId: string): Promise<{ id: string; codeHash: string }[]> {
    return this.prisma.db.userMfaRecovery.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } })
  }

  async spendRecoveryCode(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.userMfaRecovery.updateMany({ where: { id, usedAt: null }, data: { usedAt: now } })
    return count === 1
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
