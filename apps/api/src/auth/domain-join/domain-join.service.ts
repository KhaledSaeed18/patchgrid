import { Injectable, Logger } from "@nestjs/common"
import type { IdentityResponse, Role } from "@patchgrid/contracts"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem } from "../../common/problems/problem.exception"
import { MembershipRepository } from "../../memberships/repositories/membership.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { QuotaService } from "../../quota/quota.service"
import { type OrgDomainRecord, OrgDomainRepository } from "../../sso/repositories/org-domain.repository"
import type { IdentitySession } from "../sessions/session.service"

type Joinable = NonNullable<IdentityResponse["joinable"]>

/**
 * Verified-domain auto-join (TENANCY.md §5): a person whose address is
 * verified at a workspace's proved domain may join it on their own, when
 * its owner turned that on, at the role the owner chose — never above
 * agent. Never through "SSO required" (the provider is the way in then),
 * never for an SSO session, and never back in for anyone who was ever a
 * member: a removed or disabled membership stays as it is, as with SSO.
 */
@Injectable()
export class DomainJoinService {
  private readonly logger = new Logger(DomainJoinService.name)

  constructor(
    private readonly domains: OrgDomainRepository,
    private readonly users: UserRepository,
    private readonly memberships: MembershipRepository,
    private readonly workspaces: UserOrgIndexRepository,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** The workspace the picker offers to join, if any. */
  async joinableFor(session: IdentitySession): Promise<Joinable | null> {
    if (session.ssoOrgId !== null) return null
    const account = await this.users.findById(session.userId)
    if (account === null) return null
    const org = await this.joinableOrg(account)
    return org === null ? null : { slug: org.slug, name: org.name, role: org.defaultJoinRole }
  }

  /** Joins the workspace `slug` names, if it is the one the address may join; the caller then opens it. */
  async join(session: IdentitySession, slug: string): Promise<{ slug: string; role: Role }> {
    if (session.ssoOrgId !== null) throw new NotPermittedProblem("Join with your own Patchgrid sign-in")
    const account = await this.users.findById(session.userId)
    if (account === null) throw new NotPermittedProblem()
    const org = await this.joinableOrg(account)
    // Not this person's to join, whatever the reason: the same answer for every one of them.
    if (org?.slug !== slug) throw new NotFoundProblem("There is no workspace here for you to join")
    const role = org.defaultJoinRole
    const membershipId = await runAsTenant(org.id, { actor: `user:${account.id}`, reason: "join by verified domain" }, () =>
      this.prisma.transaction(async () => {
        // Under the organization lock, so a second join racing this one finds the first's membership.
        await this.memberships.lockOrganization(org.id)
        const current = await this.domains.find(org.id)
        if (current === null || !admits(current, account)) throw new NotFoundProblem("There is no workspace here for you to join")
        if ((await this.memberships.findByUser(org.id, account.id)) !== null) throw new ConflictProblem("You are already in this workspace")
        if (role !== "REQUESTER") await this.quota.consume(org.id, "AGENT_SEATS")
        const now = this.clock.now()
        const joined = { userId: account.id, role, displayName: account.name, invitedByMembershipId: null, joinedAt: now }
        // Someone who wrote in from this address before becomes the member, tickets and all (ADR-0057).
        const claimed = await this.memberships.claimExternal(org.id, account.email, joined)
        const id = claimed ?? (await this.memberships.create(org.id, joined))
        await this.workspaces.upsert({
          userId: account.id,
          orgId: org.id,
          role,
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
              entityId: id,
              diff: { via: "domain", role, domain: current.domain, claimedExternal: claimed !== null },
            },
          ],
          {
            kind: "member",
            membershipId: id,
          },
        )
        return id
      }),
    )
    this.logger.log({ msg: "member joined by verified domain", orgId: org.id, membershipId })
    return { slug: org.slug, role }
  }

  /** The proved, open workspace at the address's domain that this account was never a member of. */
  private async joinableOrg(account: AccountRecord): Promise<OrgDomainRecord | null> {
    const domain = account.email.split("@")[1]?.toLowerCase()
    if (domain === undefined) return null
    const org = await this.domains.findByVerifiedDomain(domain)
    if (org === null || !admits(org, account)) return null
    // Ever a member — removed rows stay in the picker's projection for erasure (ADR-0044) — is never again by domain.
    const known = await this.workspaces.allOrgIdsForUser(account.id)
    return known.includes(org.id) ? null : org
  }
}

function admits(org: OrgDomainRecord, account: AccountRecord): boolean {
  return (
    org.status === "ACTIVE" &&
    org.allowDomainJoin &&
    org.domainVerifiedAt !== null &&
    !org.requireSso &&
    account.emailVerifiedAt !== null &&
    account.anonymisedAt === null &&
    account.email.split("@")[1]?.toLowerCase() === org.domain
  )
}
