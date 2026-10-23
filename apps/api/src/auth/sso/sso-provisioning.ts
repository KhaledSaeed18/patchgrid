import { Injectable, Logger } from "@nestjs/common"
import type { Role, SsoErrorCode } from "@patchgrid/contracts"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { PlanLimitProblem } from "../../common/problems/problem.exception"
import { MembershipRepository } from "../../memberships/repositories/membership.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { QuotaService } from "../../quota/quota.service"
import type { SsoConnectionRecord } from "../../sso/repositories/sso-connection.repository"
import { SsoIdentityRepository } from "../../sso/repositories/sso-identity.repository"

/** A sign-in that cannot go on, with the code the login page shows. */
export class SsoFailure extends Error {
  /** Set for a step-up, whose failure lands back on the workspace rather than the login page. */
  slug: string | undefined
  /** Where on the workspace the step-up was going, so the person lands back where they were. */
  next: string | undefined

  constructor(readonly code: SsoErrorCode) {
    super(`sso: ${code}`)
  }
}

export type SsoOrg = { id: string; slug: string; name: string; status: string }

/** Who the identity provider said, already checked: a verified address at the workspace's proved domain. */
export type SsoPerson = { subject: string; email: string; name: string | null }

/**
 * How far a sign-in may go. Step-up (`mayJoin: false`) links an existing
 * member but never provisions one, must resolve to `expectedUserId` before
 * anything is written, and refuses the roles in `refuse` — an owner re-proves
 * with their own credentials, not the provider's (M13 review).
 */
export type ResolveOptions = { mayJoin: boolean; expectedUserId?: string; refuse?: readonly Role[] }

export type Resolved = { account: AccountRecord; membershipId: string; role: Role }

/**
 * Who an identity provider's subject is in this workspace (ADR-0054), inside
 * the tenant and in one transaction:
 *
 * 1. A linked subject is its membership — if that is still active.
 * 2. Otherwise the account with that address: its active membership is linked;
 *    with none, it joins at the connection's default role.
 * 3. With no account, one is created verified and without a password.
 *
 * A disabled or removed membership is never revived by a sign-in: removal has
 * to stick. An unverified account at the address loses its password before it
 * becomes the provider's (pre-account takeover). The join is audited and
 * mirrored into the picker's projection exactly as invitation acceptance does.
 */
@Injectable()
export class SsoProvisioning {
  private readonly logger = new Logger(SsoProvisioning.name)

  constructor(
    private readonly identities: SsoIdentityRepository,
    private readonly memberships: MembershipRepository,
    private readonly users: UserRepository,
    private readonly workspaces: UserOrgIndexRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async resolve(
    org: SsoOrg,
    connection: SsoConnectionRecord,
    person: SsoPerson,
    options: ResolveOptions = { mayJoin: true },
  ): Promise<Resolved> {
    try {
      return await runAsTenant(org.id, { actor: `sso:${connection.id}`, reason: "sso sign-in" }, () =>
        this.prisma.transaction(() => this.resolveInside(org, connection, person, options)),
      )
    } catch (error) {
      if (error instanceof PlanLimitProblem) throw new SsoFailure("seat")
      // Two first sign-ins racing for one person: the loser starts again and finds the winner's rows.
      if (isUniqueViolation(error)) throw new SsoFailure("expired")
      throw error
    }
  }

  private async resolveInside(org: SsoOrg, connection: SsoConnectionRecord, person: SsoPerson, options: ResolveOptions): Promise<Resolved> {
    const now = this.clock.now()
    // Checked before any write: a refused step-up links nothing and records nothing.
    const admit = (account: AccountRecord, role: Role) => {
      if (options.expectedUserId !== undefined && account.id !== options.expectedUserId) throw new SsoFailure("mismatch")
      if (options.refuse?.includes(role) === true) throw new SsoFailure("owner")
    }

    const linked = await this.identities.membershipFor(org.id, connection.id, person.subject)
    if (linked !== null) {
      const membership = await this.memberships.findById(org.id, linked)
      if (membership?.status !== "ACTIVE" || membership.userId === null) throw new SsoFailure("inactive")
      const account = await this.users.findById(membership.userId)
      if (account === null || account.anonymisedAt !== null) throw new SsoFailure("inactive")
      admit(account, membership.role)
      await this.identities.touch(org.id, connection.id, person.subject, now)
      return { account, membershipId: membership.id, role: membership.role }
    }

    let account = await this.users.findByEmail(person.email)
    if (account !== null && account.anonymisedAt !== null) throw new SsoFailure("inactive")
    if (!options.mayJoin && account === null) throw new SsoFailure("mismatch")
    if (account !== null && account.emailVerifiedAt === null) {
      account = await this.users.claimUnverified(account.id, now)
      if (account === null) throw new SsoFailure("expired")
      this.logger.warn({ msg: "unverified account claimed by sso", orgId: org.id, userId: account.id })
    }

    const existing = account === null ? null : await this.memberships.findByUser(org.id, account.id)
    if (account !== null && existing !== null) {
      if (existing.status !== "ACTIVE" || existing.kind !== "HUMAN") throw new SsoFailure("inactive")
      admit(account, existing.role)
      // One identity per member: another subject already holds this membership.
      if ((await this.identities.subjectOf(org.id, existing.id)) !== null) throw new SsoFailure("mismatch")
      await this.identities.link(org.id, connection.id, person.subject, existing.id, now)
      await this.audit.record(
        org.id,
        [{ action: "SSO_IDENTITY_LINKED", entityType: "Membership", entityId: existing.id, diff: { connectionId: connection.id } }],
        {
          kind: "member",
          membershipId: existing.id,
        },
      )
      return { account, membershipId: existing.id, role: existing.role }
    }

    if (!options.mayJoin) throw new SsoFailure("mismatch")
    const joiner = account ?? (await this.users.createProvisioned({ email: person.email, name: displayNameOf(person), verifiedAt: now }))
    // The seat is taken where the member appears; a 402 rolls the account back with it.
    if (connection.defaultRole !== "REQUESTER") await this.quota.consume(org.id, "AGENT_SEATS")
    const membershipId = await this.memberships.create(org.id, {
      userId: joiner.id,
      role: connection.defaultRole,
      displayName: joiner.name,
      invitedByMembershipId: null,
      joinedAt: now,
    })
    await this.identities.link(org.id, connection.id, person.subject, membershipId, now)
    await this.workspaces.upsert({
      userId: joiner.id,
      orgId: org.id,
      role: connection.defaultRole,
      status: "ACTIVE",
      orgSlug: org.slug,
      orgName: org.name,
      orgStatus: "ACTIVE",
    })
    await this.audit.record(
      org.id,
      [
        {
          action: "MEMBER_JOINED",
          entityType: "Membership",
          entityId: membershipId,
          diff: { via: "sso", role: connection.defaultRole, newAccount: account === null },
        },
      ],
      { kind: "member", membershipId },
    )
    this.logger.log({ msg: "member provisioned by sso", orgId: org.id, membershipId })
    return { account: joiner, membershipId, role: connection.defaultRole }
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002"
}

/** The provider's name for them, or the address's local part; never longer than a display name may be. */
function displayNameOf(person: SsoPerson): string {
  const name = person.name?.trim()
  const fallback = person.email.split("@")[0] ?? person.email
  return (name === undefined || name === "" ? fallback : name).slice(0, 100)
}
