import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/** What authentication needs about an account. Never leaves the auth module. */
export type AccountRecord = {
  id: string
  email: string
  name: string
  passwordHash: string | null
  emailVerifiedAt: Date | null
  anonymisedAt: Date | null
}

const ACCOUNT = {
  id: true,
  email: true,
  name: true,
  passwordHash: true,
  emailVerifiedAt: true,
  anonymisedAt: true,
} as const

/** `User` is platform class: one global identity, many memberships (TENANCY.md §1). */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<AccountRecord | null> {
    return this.prisma.db.user.findUnique({ where: { email }, select: ACCOUNT })
  }

  findById(id: string): Promise<AccountRecord | null> {
    return this.prisma.db.user.findUnique({ where: { id }, select: ACCOUNT })
  }

  async touchLastLogin(id: string, at: Date): Promise<void> {
    await this.prisma.db.user.update({ where: { id }, data: { lastLoginAt: at } })
  }

  /** Unverified until the emailed link is followed (TENANCY.md §4). */
  create(account: { email: string; name: string; passwordHash: string }): Promise<AccountRecord> {
    return this.prisma.db.user.create({ data: account, select: ACCOUNT })
  }

  /** An account created through an invitation link: the link proved the inbox (ADR-0031). */
  createVerified(account: { email: string; name: string; passwordHash: string; verifiedAt: Date }): Promise<AccountRecord> {
    const { verifiedAt, ...rest } = account
    return this.prisma.db.user.create({ data: { ...rest, emailVerifiedAt: verifiedAt }, select: ACCOUNT })
  }

  /**
   * An account an identity provider vouched for (ADR-0054): verified, because
   * the provider verified the address at a domain the workspace proved, and
   * without a password — its credential lives at the provider.
   */
  createProvisioned(account: { email: string; name: string; verifiedAt: Date }): Promise<AccountRecord> {
    return this.prisma.db.user.create({ data: { email: account.email, name: account.name, emailVerifiedAt: account.verifiedAt }, select: ACCOUNT })
  }

  /**
   * An unverified account at that address becomes the provider's: verified,
   * and its password dropped. Whoever signed up with someone else's address
   * and never proved it must not keep a password to an account the real owner
   * now uses (pre-account takeover, ADR-0054).
   */
  async claimUnverified(id: string, at: Date): Promise<AccountRecord | null> {
    const { count } = await this.prisma.db.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: at, passwordHash: null } })
    return count === 1 ? this.findById(id) : null
  }

  async markVerified(id: string, at: Date): Promise<void> {
    await this.prisma.db.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: at } })
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.db.user.update({ where: { id }, data: { passwordHash } })
  }
}
