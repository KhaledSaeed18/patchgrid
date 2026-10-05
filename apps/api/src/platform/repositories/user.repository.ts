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

  async markVerified(id: string, at: Date): Promise<void> {
    await this.prisma.db.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: at } })
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.db.user.update({ where: { id }, data: { passwordHash } })
  }
}
