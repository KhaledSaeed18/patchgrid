import { Injectable } from "@nestjs/common"
import type { FactorMethod } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"
import { lockPerson } from "./lock-person"

export type FactorRecord = { id: string; secretEncrypted: string; confirmedAt: Date | null; lastUsedStep: number | null }

const FACTOR = { id: true, secretEncrypted: true, confirmedAt: true, lastUsedStep: true } as const

/** The outcome of confirming TOTP: whether it won, and whether it brought the person's recovery codes. */
export type Confirmed = { confirmed: boolean; codesIssued: boolean }

/**
 * A person's second factors and recovery codes (ADR-0029). Platform class:
 * they belong to the person, not to any workspace. Every "use" is a
 * conditional update, so two requests racing with one code cannot both win.
 *
 * The recovery codes belong to the person, not to one kind of factor
 * (ADR-0053): they arrive with the first factor of any kind and leave with
 * the last. Every change to which factors exist locks the person's row, so
 * two changes racing cannot both decide they were the first or the last.
 */
@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The kinds of factor a person holds — a confirmed authenticator app, passkeys — in one read. */
  async methods(userId: string): Promise<FactorMethod[]> {
    const row = await this.prisma.db.user.findUnique({
      where: { id: userId },
      select: { _count: { select: { passkeys: true, mfaFactors: { where: { kind: "TOTP", confirmedAt: { not: null } } } } } },
    })
    if (row === null) return []
    return [...(row._count.mfaFactors > 0 ? (["totp"] as const) : []), ...(row._count.passkeys > 0 ? (["passkey"] as const) : [])]
  }

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

  /**
   * Confirms the factor with its first accepted step and, when it is the
   * person's first factor of any kind, issues the recovery codes with it.
   * `recoveryHashes` is what the caller prepared expecting to be first; with a
   * passkey already held the codes they have stand.
   */
  async confirm(userId: string, factorId: string, step: number, now: Date, recoveryHashes: readonly string[] | null): Promise<Confirmed> {
    // Two enrolments confirmed at once: the one-confirmed-factor index lets one win; the other is a refusal, not a 500.
    return this.confirmOnce(userId, factorId, step, now, recoveryHashes).catch((error: unknown) => {
      if (isUniqueViolation(error)) return { confirmed: false, codesIssued: false }
      throw error
    })
  }

  private confirmOnce(userId: string, factorId: string, step: number, now: Date, recoveryHashes: readonly string[] | null): Promise<Confirmed> {
    return this.prisma.db.$transaction(async (tx) => {
      await lockPerson(tx, userId)
      const { count } = await tx.userMfaFactor.updateMany({
        where: { id: factorId, userId, confirmedAt: null },
        data: { confirmedAt: now, lastUsedStep: step, lastUsedAt: now },
      })
      if (count !== 1) return { confirmed: false, codesIssued: false }
      const first = (await tx.userPasskey.count({ where: { userId } })) === 0
      if (!first || recoveryHashes === null) return { confirmed: true, codesIssued: false }
      await tx.userMfaRecovery.deleteMany({ where: { userId } })
      await tx.userMfaRecovery.createMany({ data: recoveryHashes.map((codeHash) => ({ userId, codeHash })) })
      return { confirmed: true, codesIssued: true }
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

  /** Fresh recovery codes in place of whatever was left — used and unused alike. */
  async replaceRecoveryCodes(userId: string, recoveryHashes: readonly string[]): Promise<void> {
    await this.prisma.db.$transaction(async (tx) => {
      await tx.userMfaRecovery.deleteMany({ where: { userId } })
      await tx.userMfaRecovery.createMany({ data: recoveryHashes.map((codeHash) => ({ userId, codeHash })) })
    })
  }

  /** Turning the authenticator app off; the recovery codes go too when no passkey remains. */
  async removeTotp(userId: string): Promise<void> {
    await this.prisma.db.$transaction(async (tx) => {
      await lockPerson(tx, userId)
      await tx.userMfaFactor.deleteMany({ where: { userId } })
      if ((await tx.userPasskey.count({ where: { userId } })) === 0) await tx.userMfaRecovery.deleteMany({ where: { userId } })
    })
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
