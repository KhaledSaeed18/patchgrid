import { Injectable, Logger } from "@nestjs/common"
import type { AcceptInvitationResponse, InvitationPreview } from "@patchgrid/contracts"

import type { CookieSpec } from "../../auth/cookies"
import { PasswordService } from "../../auth/passwords/password.service"
import { type ClientInfo, hash, SessionService } from "../../auth/sessions/session.service"
import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import {
  ConflictProblem,
  NotFoundProblem,
  OrganizationSuspendedProblem,
} from "../../common/problems/problem.exception"
import { type OrganizationProfile, OrganizationRepository } from "../../platform/repositories/organization.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { TeamRepository } from "../../teams/repositories/team.repository"
import { parseInvitationToken } from "../invitations/invitation-token"
import { type InvitationRecord, InvitationRepository } from "../repositories/invitation.repository"
import { MembershipRepository } from "../repositories/membership.repository"

/** Bad format, unknown org, wrong secret, expired, used, revoked: one answer (ADR-0033). */
const INVALID = "This invitation is invalid or has expired"

type Resolved = { org: OrganizationProfile; invitation: InvitationRecord }

/**
 * Turning an invitation into a membership (ADR-0033, TENANCY.md §5).
 *
 * The routes are tenant-less — the holder is not a member yet — so the token's
 * org part names the tenant and every tenant-owned read and write here runs
 * inside `runAsTenant` on it, under RLS like any request (ADR-0022). That is
 * why this folder is on the crossing's allow-list.
 *
 * The invitation is bound to its address (ADR-0031): the accepting account's
 * email must equal the invited one, and an account created through the link
 * starts verified, because following it proved the inbox.
 */
@Injectable()
export class InvitationAcceptanceService {
  private readonly logger = new Logger(InvitationAcceptanceService.name)

  constructor(
    private readonly invitations: InvitationRepository,
    private readonly memberships: MembershipRepository,
    private readonly teams: TeamRepository,
    private readonly organizations: OrganizationRepository,
    private readonly users: UserRepository,
    private readonly workspaces: UserOrgIndexRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async preview(token: string): Promise<InvitationPreview> {
    const { org, invitation } = await this.resolve(token)
    const account = await this.users.findByEmail(invitation.email)
    return {
      organization: { name: org.name, slug: org.slug },
      role: invitation.role,
      accountExists: account !== null && account.anonymisedAt === null,
    }
  }

  /** A signed-in holder (`pg_id`) joins as themselves. */
  async accept(
    userId: string,
    token: string,
    client: ClientInfo,
  ): Promise<{ response: AcceptInvitationResponse; cookies: CookieSpec[] }> {
    const resolved = await this.resolve(token)
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null) throw new NotFoundProblem(INVALID)
    if (account.email !== resolved.invitation.email) {
      // The holder has proved they hold a valid link, so they may learn it was
      // not meant for them — but not who it was meant for (ADR-0031).
      throw new NotFoundProblem("This invitation was sent to a different address")
    }
    const { membershipId } = await this.join(resolved, () => Promise.resolve(account))
    const cookies = await this.sessions.open(account.id, resolved.org.slug, client)
    return { response: responseFor(resolved.org, membershipId), cookies }
  }

  /** A holder with no account creates one, verified, and joins with it. */
  async acceptNew(
    token: string,
    name: string,
    password: string,
    client: ClientInfo,
  ): Promise<{ response: AcceptInvitationResponse; cookies: CookieSpec[] }> {
    const passwordHash = await this.passwords.hash(password)
    const resolved = await this.resolve(token)
    if ((await this.users.findByEmail(resolved.invitation.email)) !== null) {
      throw new ConflictProblem("An account already exists for this address; sign in to accept")
    }

    // Created inside the joining transaction: an invitation that cannot be
    // consumed leaves no orphaned account behind.
    const { membershipId, account } = await this.join(resolved, () =>
      this.users.createVerified({
        email: resolved.invitation.email,
        name,
        passwordHash,
        verifiedAt: this.clock.now(),
      }),
    )
    const { cookies } = await this.sessions.startIdentity(account, client, resolved.org.slug)
    return { response: responseFor(resolved.org, membershipId), cookies }
  }

  /** Token → organization and live invitation, or the one generic `404`. */
  private async resolve(token: string): Promise<Resolved> {
    const parsed = parseInvitationToken(token)
    if (parsed === null) throw new NotFoundProblem(INVALID)
    const org = await this.organizations.findProfileById(parsed.orgId)
    if (org === null || org.status === "PENDING_DELETION") throw new NotFoundProblem(INVALID)

    const now = this.clock.now()
    const invitation = await runAsTenant(org.id, { actor: "invitation", reason: "resolve invitation" }, () =>
      this.invitations.findByTokenHash(org.id, hash(parsed.secret)),
    )
    if (
      invitation === null ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      throw new NotFoundProblem(INVALID)
    }
    // Only now, with a valid token in hand, is the workspace's state worth telling.
    if (org.status === "SUSPENDED") throw new OrganizationSuspendedProblem("This workspace is suspended")
    return { org, invitation }
  }

  /**
   * One transaction inside the tenant: burn the invitation (conditionally, so
   * two acceptances of one token cannot both win), create or reactivate the
   * membership, seed its team, mirror the picker row, audit the join.
   */
  private join(
    resolved: Resolved,
    accountFor: () => Promise<AccountRecord>,
  ): Promise<{ membershipId: string; account: AccountRecord }> {
    const { org, invitation } = resolved
    return runAsTenant(org.id, { actor: "invitation", reason: "accept invitation" }, () =>
      this.prisma.transaction(async () => {
        const now = this.clock.now()
        if (!(await this.invitations.consume(org.id, invitation.id, now))) throw new NotFoundProblem(INVALID)
        const account = await accountFor()

        const existing = await this.memberships.findByUser(org.id, account.id)
        if (existing !== null && existing.status !== "REMOVED") {
          throw new ConflictProblem("You are already a member of this workspace")
        }
        const joined = {
          role: invitation.role,
          displayName: account.name,
          invitedByMembershipId: invitation.invitedByMembershipId,
          joinedAt: now,
        }
        let membershipId: string
        if (existing === null) {
          membershipId = await this.memberships.create(org.id, { userId: account.id, ...joined })
        } else {
          // A removed member comes back as the same row (ADR-0033).
          membershipId = existing.id
          await this.memberships.reactivate(org.id, existing.id, joined)
        }

        let teamId: string | null = null
        if (invitation.teamId !== null) {
          // The team may have been deactivated since the invitation was sent.
          const team = await this.teams.findById(org.id, invitation.teamId)
          if (team?.isActive === true) {
            await this.memberships.joinTeam(org.id, membershipId, team.id)
            teamId = team.id
          }
        }

        await this.workspaces.upsert({
          userId: account.id,
          orgId: org.id,
          role: invitation.role,
          status: "ACTIVE",
          orgSlug: org.slug,
          orgName: org.name,
          orgStatus: org.status,
        })
        await this.audit.record(
          org.id,
          [
            {
              action: "MEMBER_JOINED",
              entityType: "Membership",
              entityId: membershipId,
              diff: { invitationId: invitation.id, role: invitation.role, teamId, rejoined: existing !== null },
            },
          ],
          { kind: "member", membershipId },
        )
        this.logger.log({ msg: "invitation accepted", orgId: org.id, membershipId })
        return { membershipId, account }
      }),
    )
  }
}

function responseFor(org: OrganizationProfile, membershipId: string): AcceptInvitationResponse {
  return { organization: { id: org.id, name: org.name, slug: org.slug }, membershipId, session: { slug: org.slug } }
}
