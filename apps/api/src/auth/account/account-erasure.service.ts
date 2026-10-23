import { Injectable, Logger } from "@nestjs/common"
import { randomBytes } from "node:crypto"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { MailService } from "../../mail/mail.service"
import { MembershipRepository } from "../../memberships/repositories/membership.repository"
import { OrganizationRepository } from "../../platform/repositories/organization.repository"
import { PlatformAdminRepository } from "../../platform/repositories/platform-admin.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { UserRepository } from "../../platform/repositories/user.repository"
import { runAsPlatform } from "../../platform/run-as-platform"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { holdsSeat, QuotaService } from "../../quota/quota.service"
import type { CookieName } from "../cookies"
import { PasswordService } from "../passwords/password.service"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { hash, SessionService } from "../sessions/session.service"
import { ERASURE_LINK_MINUTES, ErasureLinks } from "./erasure-links"
import { AccountErasureRepository } from "./repositories/account-erasure.repository"

/** Where a workspace still needs someone to own it before its last owner can leave. */
const OWNED = new Set(["ACTIVE", "SUSPENDED"])

/**
 * A person erasing their own account (ADR-0028, ADR-0044): password again,
 * never while a workspace would be left without an owner or while a platform
 * grant stands. Then every session ends; in each workspace the membership is
 * removed and stops naming them; the account becomes a tombstone. The work in
 * a workspace runs inside that workspace — this crosses tenants, which is why
 * it lives where `runAsTenant` may be used.
 */
@Injectable()
export class AccountErasureService {
  private readonly logger = new Logger(AccountErasureService.name)

  constructor(
    private readonly erasure: AccountErasureRepository,
    private readonly users: UserRepository,
    private readonly workspaces: UserOrgIndexRepository,
    private readonly organizations: OrganizationRepository,
    private readonly platformAdmins: PlatformAdminRepository,
    private readonly memberships: MembershipRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly epochs: RevocationEpochService,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly links: ErasureLinks,
    private readonly urls: PublicUrls,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** Returns the cookies to clear: every workspace's pair, and `pg_id`. */
  async erase(userId: string, password: string): Promise<CookieName[]> {
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotAuthenticatedProblem("A session is required")
    if (!(await this.passwords.verify(account.passwordHash, password))) {
      throw new ValidationProblem([{ path: "password", message: "is not this account's password", code: "wrong_password" }])
    }
    return this.eraseProved(account)
  }

  /**
   * `202` always: an erasure link, to a verified, live account's address. For
   * whoever has no password to give — an account a workspace's identity
   * provider made — and no weaker than the password reset the same inbox
   * could already ask for.
   */
  async requestLink(email: string): Promise<void> {
    const account = await this.users.findByEmail(email)
    if (account === null || account.emailVerifiedAt === null || account.anonymisedAt !== null) return
    const secret = randomBytes(32).toString("base64url")
    await this.links.put(secret, account.id)
    await this.mail.enqueue(
      {
        kind: "confirm-erasure",
        to: account.email,
        orgId: null,
        fromName: "Patchgrid",
        params: { name: account.name, confirmUrl: this.urls.app(`/erase-account?token=${secret}`), expiresInMinutes: ERASURE_LINK_MINUTES },
      },
      `${account.id}-erase-${hash(secret).slice(0, 16)}`,
    )
  }

  /** The link, spent: the account it names is erased as if its password had been given. */
  async confirmLink(secret: string): Promise<CookieName[]> {
    const userId = await this.links.take(secret)
    const account = userId === null ? null : await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotAuthenticatedProblem("This erasure link is invalid or has expired")
    return this.eraseProved(account)
  }

  private async eraseProved(account: { id: string; email: string }): Promise<CookieName[]> {
    const userId = account.id
    if ((await this.platformAdmins.activeForUser(userId)) !== null) {
      throw new ConflictProblem("This account holds a platform grant; have it revoked first")
    }
    const orgIds = await this.workspaces.allOrgIdsForUser(userId)
    const sole = await this.soleOwnerOf(userId, orgIds)
    if (sole.length > 0) throw new ConflictProblem(`Hand over or delete these workspaces first: ${sole.join(", ")}`)

    // Every session ends first: nothing half-erased stays signed in.
    const clear = await this.sessions.revokeEverywhere(userId)
    const now = this.clock.now()
    // The account's id, not a hash of its address: a hash could be recomputed by anyone who knew the
    // address, and a second account under the same address would collide with the first (ADR-0044 erratum).
    const tombstone = `deleted+${userId}@invalid`
    let erased = 0
    for (const orgId of orgIds) if (await this.eraseIn(orgId, userId, account.email, tombstone, now)) erased += 1

    await runAsPlatform({ actor: `user:${userId}`, reason: "erase account" }, () =>
      this.prisma.transaction(() => this.erasure.tombstoneAccount(userId, tombstone, now)),
    )
    await this.mail
      .enqueue({ kind: "account-erased", to: account.email, orgId: null, fromName: "Patchgrid", params: { workspaceCount: erased } }, userId)
      .catch((error: unknown) => this.logger.error({ msg: "erasure mail not queued", userId, error: String(error) }))
    return clear
  }

  /** The slugs of workspaces this account is the only active owner of — each read inside its tenant. */
  private async soleOwnerOf(userId: string, orgIds: readonly string[]): Promise<string[]> {
    const sole: string[] = []
    for (const orgId of orgIds) {
      const org = await this.organizations.findProfileById(orgId)
      if (org === null || !OWNED.has(org.status)) continue
      const only = await runAsTenant(orgId, { actor: `user:${userId}`, reason: "check ownership before erasure" }, () =>
        this.prisma.transaction(async () => {
          const membership = await this.memberships.findByUser(orgId, userId)
          if (membership?.role !== "OWNER" || membership.status !== "ACTIVE") return false
          return (await this.memberships.countActiveOwners(orgId)) <= 1
        }),
      )
      if (only) sole.push(org.slug)
    }
    return sole
  }

  /**
   * One workspace, one transaction, under its organization lock: out, seat
   * back, teams left, nameless, nobody watching for them, audited with
   * themselves as the actor. Re-checks the last-owner rule under the lock; a
   * promotion racing it stops the erasure there, before the account is touched.
   */
  private async eraseIn(orgId: string, userId: string, email: string, tombstone: string, now: Date): Promise<boolean> {
    const membershipId = await runAsTenant(orgId, { actor: `user:${userId}`, reason: "erase account" }, () =>
      this.prisma.transaction(async () => {
        await this.memberships.lockOrganization(orgId)
        // Read under the lock: a cancel or restore landing first changes who must stay an owner.
        const org = await this.organizations.findProfileById(orgId)
        const membership = await this.memberships.findByUser(orgId, userId)
        if (membership === null) return null
        // Done on an earlier attempt that stopped at another workspace: nothing to do twice.
        if (await this.erasure.isAnonymised(orgId, membership.id)) return membership.id
        if (org !== null && OWNED.has(org.status) && membership.role === "OWNER" && membership.status === "ACTIVE") {
          if ((await this.memberships.countActiveOwners(orgId)) <= 1) throw new ConflictProblem(`Hand over or delete ${org.slug} first`)
        }
        if (holdsSeat(membership)) await this.quota.release(orgId, "AGENT_SEATS")
        const leftTeams = await this.memberships.leaveAllTeams(orgId, membership.id)
        await this.erasure.anonymiseMembership(orgId, membership.id, now)
        await this.erasure.forgetPresence(orgId, membership.id, userId)
        await this.erasure.forgetInvitations(orgId, email, tombstone)
        await this.erasure.forgetInboundSenders(orgId, email, tombstone)
        // Off the picker now, not only when the account is tombstoned at the end.
        await this.workspaces.markRemoved(userId, orgId)
        await this.audit.record(
          orgId,
          [{ action: "MEMBER_REMOVED", entityType: "Membership", entityId: membership.id, diff: { erased: true, ...(leftTeams.length > 0 ? { leftTeams } : {}) } }],
          { kind: "member", membershipId: membership.id },
        )
        return membership.id
      }),
    )
    if (membershipId === null) return false
    await this.epochs.bump(membershipId)
    return true
  }
}
