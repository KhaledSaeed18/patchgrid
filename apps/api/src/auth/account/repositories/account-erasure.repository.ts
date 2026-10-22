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

  /** Inside the tenant: already erased — an erasure retried after a refusal elsewhere skips it. */
  async isAnonymised(orgId: string, membershipId: string): Promise<boolean> {
    const row = await this.prisma.db.membership.findUnique({ where: { orgId_id: { orgId, id: membershipId } }, select: { anonymisedAt: true } })
    return row?.anonymisedAt != null
  }

  /** Inside the tenant: invitations to the person's address name them too (ADR-0044 erratum). */
  async forgetInvitations(orgId: string, email: string, tombstone: string): Promise<void> {
    await this.prisma.db.invitation.updateMany({ where: { orgId, email }, data: { email: tombstone } })
  }

  /** Inside the tenant: nobody is watching for them, and nothing waits to be delivered to them. */
  /** Mail the person sent in keeps its ticket; the address on the row goes (M9 review). */
  async forgetInboundSenders(orgId: string, email: string, tombstone: string): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({ where: { orgId, fromAddress: email }, data: { fromAddress: tombstone } })
  }

  async forgetPresence(orgId: string, membershipId: string, userId: string): Promise<void> {
    await this.prisma.db.ticketWatcher.deleteMany({ where: { orgId, membershipId } })
    await this.prisma.db.notification.deleteMany({ where: { orgId, userId } })
  }

  /**
   * The account itself: a tombstone address nobody can sign in with or be
   * mailed at, no name, no password, no second factor or passkey, no tokens, no picker.
   * Must run inside `transaction()`.
   */
  async tombstoneAccount(userId: string, tombstoneEmail: string, at: Date): Promise<void> {
    await this.prisma.db.userMfaRecovery.deleteMany({ where: { userId } })
    await this.prisma.db.userMfaFactor.deleteMany({ where: { userId } })
    await this.prisma.db.userPasskey.deleteMany({ where: { userId } })
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
