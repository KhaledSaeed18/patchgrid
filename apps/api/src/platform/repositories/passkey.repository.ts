import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"
import { lockPerson } from "./lock-person"

/** A passkey as its owner's account page shows it. */
export type PasskeyRecord = {
  id: string
  label: string
  credentialId: Uint8Array
  transports: string[]
  backedUp: boolean
  createdAt: Date
  lastUsedAt: Date | null
}

/** What an assertion is verified against. */
export type StoredCredential = {
  id: string
  userId: string
  credentialId: Uint8Array
  publicKey: Uint8Array
  signCount: bigint
  transports: string[]
}

export type NewPasskey = {
  credentialId: Uint8Array
  publicKey: Uint8Array
  signCount: bigint
  transports: string[]
  aaguid: string
  backedUp: boolean
  label: string
}

const LISTED = { id: true, label: true, credentialId: true, transports: true, backedUp: true, createdAt: true, lastUsedAt: true } as const
const STORED = { id: true, userId: true, credentialId: true, publicKey: true, signCount: true, transports: true } as const

/**
 * A person's passkeys (ADR-0053). Platform class, like the factor tables: a
 * passkey belongs to the person, not to a workspace, so every method is keyed
 * by `userId` and nothing here takes an `orgId`. Adding and removing lock the
 * person's row, because the recovery codes come with the first factor of any
 * kind and go with the last.
 */
@Injectable()
export class PasskeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<PasskeyRecord[]> {
    return this.prisma.db.userPasskey.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: LISTED })
  }

  findByCredentialId(credentialId: Uint8Array): Promise<StoredCredential | null> {
    return this.prisma.db.userPasskey.findUnique({ where: { credentialId: Uint8Array.from(credentialId) }, select: STORED })
  }

  /**
   * Adds a passkey and, when it is the person's first factor of any kind, the
   * recovery codes the caller prepared. `null` when the credential is already
   * registered — to this person or anyone.
   */
  async add(
    userId: string,
    passkey: NewPasskey,
    recoveryHashes: readonly string[] | null,
  ): Promise<{ passkey: PasskeyRecord; codesIssued: boolean } | null> {
    try {
      return await this.prisma.db.$transaction(async (tx) => {
        await lockPerson(tx, userId)
        const first =
          (await tx.userPasskey.count({ where: { userId } })) === 0 &&
          (await tx.userMfaFactor.count({ where: { userId, kind: "TOTP", confirmedAt: { not: null } } })) === 0
        const created = await tx.userPasskey.create({
          data: { userId, ...passkey, credentialId: Uint8Array.from(passkey.credentialId), publicKey: Uint8Array.from(passkey.publicKey) },
          select: LISTED,
        })
        if (!first || recoveryHashes === null) return { passkey: created, codesIssued: false }
        await tx.userMfaRecovery.deleteMany({ where: { userId } })
        await tx.userMfaRecovery.createMany({ data: recoveryHashes.map((codeHash) => ({ userId, codeHash })) })
        return { passkey: created, codesIssued: true }
      })
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  async rename(userId: string, id: string, label: string): Promise<PasskeyRecord | null> {
    const { count } = await this.prisma.db.userPasskey.updateMany({ where: { id, userId }, data: { label } })
    if (count !== 1) return null
    return this.prisma.db.userPasskey.findFirst({ where: { id, userId }, select: LISTED })
  }

  /** Removes one of the person's passkeys; the recovery codes go too when it was their last factor. */
  remove(userId: string, id: string): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      await lockPerson(tx, userId)
      const { count } = await tx.userPasskey.deleteMany({ where: { id, userId } })
      if (count !== 1) return false
      const left =
        (await tx.userPasskey.count({ where: { userId } })) +
        (await tx.userMfaFactor.count({ where: { userId, kind: "TOTP", confirmedAt: { not: null } } }))
      if (left === 0) await tx.userMfaRecovery.deleteMany({ where: { userId } })
      return true
    })
  }

  /**
   * Records a verified use: the new counter, whether it is now synced, and
   * when. Conditional on the counter the verification read, so two
   * assertions racing with one counter cannot both be recorded.
   */
  async recordUse(id: string, readCount: bigint, newCount: bigint, backedUp: boolean, now: Date): Promise<boolean> {
    const { count } = await this.prisma.db.userPasskey.updateMany({
      where: { id, signCount: readCount },
      data: { signCount: newCount, backedUp, lastUsedAt: now },
    })
    return count === 1
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
