import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../../prisma/prisma.service"

/** What every erased membership is called, in every workspace (ADR-0028). */
export const FORMER_MEMBER = "Former member"

/**
 * Erasure's writes (ADR-0028, ADR-0044). The membership half runs inside
 * `runAsTenant` for each workspace; the account half touches platform-class
 * tables only. Nothing in a ticket, a comment or the audit log is rewritten:
 * they point at the membership, and the membership stops naming a person.
 */
@Injectable()
export class AccountErasureRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Inside the tenant: out of the workspace, and nameless. */
  async anonymiseMembership(orgId: string, membershipId: string, at: Date): Promise<void> {
    await this.prisma.db.membership.update({
      where: { orgId_id: { orgId, id: membershipId } },
      data: { status: "REMOVED", displayName: FORMER_MEMBER, avatarUrl: null, anonymisedAt: at },
    })
  }

  /** Inside the tenant: nobody is watching for them, and nothing waits to be delivered to them. */
  async forgetPresence(orgId: string, membershipId: string, userId: string): Promise<void> {
    await this.prisma.db.ticketWatcher.deleteMany({ where: { orgId, membershipId } })
    await this.prisma.db.notification.deleteMany({ where: { orgId, userId } })
  }

  /**
   * The account itself: a tombstone address nobody can sign in with or be
   * mailed at, no name, no password, no second factor, no tokens, no picker.
   * Must run inside `transaction()`.
   */
  async tombstoneAccount(userId: string, tombstoneEmail: string, at: Date): Promise<void> {
    await this.prisma.db.userMfaRecovery.deleteMany({ where: { userId } })
    await this.prisma.db.userMfaFactor.deleteMany({ where: { userId } })
    await this.prisma.db.passwordResetToken.deleteMany({ where: { userId } })
    await this.prisma.db.emailVerification.deleteMany({ where: { userId } })
    await this.prisma.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } })
    await this.prisma.db.userOrgIndex.deleteMany({ where: { userId } })
    await this.prisma.db.user.update({
      where: { id: userId },
      data: { email: tombstoneEmail, name: "", passwordHash: null, anonymisedAt: at },
    })
  }
}
