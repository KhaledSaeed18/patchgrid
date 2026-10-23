import { Inject, Injectable, Logger } from "@nestjs/common"
import type { IdentityResponse, LoginResponse, SignedInResponse } from "@patchgrid/contracts"
import { createHash, randomBytes } from "node:crypto"

import { type Clock, InjectClock } from "../../common/clock/clock"
import {
  MfaRequiredProblem,
  SsoRequiredProblem,
  SsoSessionScopedProblem,
  NotAuthenticatedProblem,
  NotFoundProblem,
  NotPermittedProblem,
  OrganizationSuspendedProblem,
  TenantMismatchProblem,
} from "../../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import {
  MembershipRepository,
  type MembershipRecord,
} from "../../memberships/repositories/membership.repository"
import { MfaRepository } from "../../platform/repositories/mfa.repository"
import type { OrganizationSummary } from "../../platform/repositories/organization.repository"
import { RefreshTokenRepository } from "../../platform/repositories/refresh-token.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "../../tenancy/organization-lookup"
import { type CookieName, CookieService, type CookieSpec } from "../cookies"
import { MFA_CHALLENGE_TTL_SECONDS, MfaChallengeService } from "../mfa/mfa-challenge.service"
import { PasswordService } from "../passwords/password.service"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { AccessTokenService } from "../tokens/access-token.service"

/** Where the credential is being used from — recorded on the refresh token, never logged. */
export type ClientInfo = { userAgent: string | null; ip: string | null }

/**
 * A pair minted after a step-up carries when it was proved (ADR-0029). A pair
 * minted from an SSO session carries its scope (ADR-0054): `ssoOrgId` is the
 * workspace whose identity provider started it, `null` for Patchgrid
 * credentials.
 */
export type OpenOptions = { stepUpAt?: Date; ssoOrgId?: string | null }

/** What a live `pg_id` says: who, and which workspace's identity provider started it, if one did. */
export type IdentitySession = { userId: string; ssoOrgId: string | null }

export type LogoutInput = {
  slug: string | undefined
  everywhere: boolean
  /** The `pg_rt_<slug>` cookie, if presented. */
  refreshSecret: string | undefined
  /** The `pg_id` cookie, if presented. */
  identitySecret: string | undefined
}

/**
 * Sessions (ADR-0004, ADR-0024, ADR-0031).
 *
 * - `pg_id` is a `RefreshToken` with `orgId = NULL`; a tenant pair is a signed
 *   access token plus a `RefreshToken` for that org. All secrets are 256-bit
 *   random, stored as SHA-256, and never logged.
 * - Minting a pair **re-reads `Membership` inside `runAsTenant`** — never the
 *   picker's projection — so a stale index can list a workspace but cannot
 *   open one.
 * - Refresh rotates; presenting a rotated token revokes its whole chain.
 * - Login answers uniformly: unknown address, wrong password, unverified or
 *   anonymised account are one 401, at one Argon2id cost.
 * - A second factor — a confirmed authenticator app or a passkey — turns the
 *   right password into a challenge, not a session (ADR-0045, ADR-0053); and a
 *   workspace that requires one opens for nobody without it — at open and
 *   refresh, never mid-session.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name)

  constructor(
    private readonly users: UserRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly memberships: MembershipRepository,
    private readonly workspaces: UserOrgIndexRepository,
    @Inject(ORGANIZATION_LOOKUP) private readonly organizations: OrganizationLookup,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly epochs: RevocationEpochService,
    private readonly cookies: CookieService,
    private readonly mfa: MfaRepository,
    private readonly challenges: MfaChallengeService,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async login(
    email: string,
    password: string,
    slug: string | undefined,
    client: ClientInfo,
  ): Promise<{ response: LoginResponse; cookies: CookieSpec[] }> {
    const account = await this.users.findByEmail(email)
    // One verification whether or not the account exists (ADR-0031).
    const passwordOk = await this.passwords.verify(account?.passwordHash ?? null, password)
    if (account === null || !passwordOk || !isUsable(account)) {
      throw new NotAuthenticatedProblem("Invalid email or password")
    }

    // The password was right; with a factor held that is a challenge, not a session.
    const methods = await this.mfa.methods(account.id)
    if (methods.length > 0) {
      const challenge = await this.challenges.issue(account.id, slug)
      return { response: { status: "mfa-required", methods }, cookies: [this.cookies.mfaChallenge(challenge, MFA_CHALLENGE_TTL_SECONDS)] }
    }

    return this.startIdentity(account, client, slug)
  }

  /**
   * A verified account becomes a `pg_id` — and, when a slug is given and the
   * user is a member, that workspace's pair. Login and the verification link
   * both end here (ADR-0031: the link completes signup and starts the session).
   */
  async startIdentity(
    account: AccountRecord,
    client: ClientInfo,
    slug?: string,
    ssoOrgId: string | null = null,
  ): Promise<{ response: SignedInResponse; cookies: CookieSpec[] }> {
    const now = this.clock.now()
    const identity = await this.issue(account.id, null, client, now, undefined, ssoOrgId)
    await this.users.touchLastLogin(account.id, now)
    const cookies: CookieSpec[] = [this.cookies.identity(identity)]

    let session: SignedInResponse["session"] = null
    if (slug !== undefined) {
      const pair = await this.tryOpen(account.id, slug, client, now, ssoOrgId)
      if (pair !== null) {
        cookies.push(...pair)
        session = { slug }
      }
    }

    return {
      response: {
        status: "signed-in",
        user: { id: account.id, email: account.email, name: account.name },
        workspaces: await this.workspaces.listWorkspacesForUser(account.id),
        session,
      },
      cookies,
    }
  }

  /**
   * Ends every session of a user: every refresh token and `pg_id` revoked, every
   * membership's epoch bumped so the stateless access tokens die now rather than
   * in fifteen minutes. "Log out everywhere", password reset and password change
   * all come here (ADR-0024 §5, ADR-0031). Returns the cookies to clear.
   * `before` spares a credential minted in this very second — the session a
   * recovery code is about to earn (ADR-0045).
   */
  async revokeEverywhere(userId: string, options: { before?: boolean } = {}): Promise<CookieName[]> {
    const now = this.clock.now()
    const clear: CookieName[] = []
    await this.refreshTokens.revokeAllForUser(userId, now)
    // The projection only tells us where to look; the membership is read inside
    // the tenant, and a disabled one still has an epoch worth bumping.
    for (const workspace of await this.workspaces.listWorkspacesForUser(userId)) {
      const org = await this.organizations.byId(workspace.orgId)
      if (org === null) continue
      const membership = await this.membershipOf(org, userId, "revoke everywhere", false)
      if (membership !== null) await this.epochs.bump(membership.id, options)
      clear.push(...this.cookies.pairOf(org.slug))
    }
    clear.push({ name: this.cookies.identity("").name, path: "/" })
    return clear
  }

  /** Every session this person holds in one workspace, and the scoped identity: what an SSO session may end. */
  private async revokeWithinScope(userId: string, orgId: string): Promise<CookieName[]> {
    await this.refreshTokens.revokeWithinScope(userId, orgId, this.clock.now())
    const org = await this.organizations.byId(orgId)
    if (org === null) return [{ name: this.cookies.identity("").name, path: "/" }]
    const membership = await this.membershipOf(org, userId, "revoke within sso scope", false)
    if (membership !== null) await this.epochs.bump(membership.id)
    return [...this.cookies.pairOf(org.slug), { name: this.cookies.identity("").name, path: "/" }]
  }

  /** Who a `pg_id` holder is and which workspaces the picker lists for them. */
  async identity(session: IdentitySession): Promise<Omit<IdentityResponse, "joinable">> {
    const account = await this.users.findById(session.userId)
    if (account === null || !isUsable(account)) throw new NotAuthenticatedProblem("A session is required")
    const scope = session.ssoOrgId === null ? null : await this.organizations.byId(session.ssoOrgId)
    const workspaces = await this.workspaces.listWorkspacesForUser(account.id)
    // An SSO session learns nothing of the person beyond its workspace: not the others, not their factors (M13 review).
    if (session.ssoOrgId !== null) {
      return { user: { id: account.id, email: account.email, name: account.name }, workspaces: workspaces.filter((w) => w.orgId === session.ssoOrgId), mfa: { enrolled: false }, sso: scope === null ? null : { slug: scope.slug } }
    }
    return {
      user: { id: account.id, email: account.email, name: account.name },
      workspaces,
      mfa: { enrolled: (await this.mfa.methods(account.id)).length > 0 },
      sso: null,
    }
  }

  /** The org switcher: a `pg_id` holder opens one workspace they belong to. */
  async open(userId: string, slug: string, client: ClientInfo, options: OpenOptions = {}): Promise<CookieSpec[]> {
    const org = await this.organizations.bySlug(slug)
    if (org === null) throw new NotFoundProblem("Unknown workspace")
    assertServing(org)
    const membership = await this.membershipOf(org, userId, "open session")
    if (membership === null) {
      throw new NotPermittedProblem("You are not a member of this workspace")
    }
    const ssoOrgId = options.ssoOrgId ?? null
    await this.assertSessionPolicy(org, membership, userId, ssoOrgId)
    return this.mint(userId, org, membership, client, this.clock.now(), undefined, { ...options, ssoOrgId })
  }

  /** `pg_id` → who it identifies and its SSO scope, or `null` for anything invalid. */
  async identityFor(secret: string | undefined): Promise<IdentitySession | null> {
    if (secret === undefined) return null
    const row = await this.refreshTokens.findByHash(hash(secret))
    if (row === null || row.orgId !== null || !isLive(row, this.clock.now())) return null
    return { userId: row.userId, ssoOrgId: row.ssoOrgId }
  }

  async refresh(slug: string, presented: string | undefined, client: ClientInfo): Promise<CookieSpec[]> {
    if (presented === undefined) throw new NotAuthenticatedProblem("No refresh token")
    const now = this.clock.now()
    const row = await this.refreshTokens.findByHash(hash(presented))
    if (row === null || row.orgId === null) throw new NotAuthenticatedProblem("Invalid refresh token")

    if (row.replacedById !== null) {
      // Theft signal (ADR-0004): someone holds a token that was already rotated.
      // Whoever holds the newest one loses it too; that is the point.
      const revoked = await this.refreshTokens.revokeChainFrom(row.id, now)
      this.logger.warn({ msg: "refresh token reuse", userId: row.userId, orgId: row.orgId, revoked })
      throw new NotAuthenticatedProblem("Invalid refresh token")
    }
    if (!isLive(row, now)) throw new NotAuthenticatedProblem("Invalid refresh token")

    const org = await this.organizations.byId(row.orgId)
    if (org === null) throw new NotAuthenticatedProblem("Invalid refresh token")
    // The cookie was named by `slug`; a token for another org under that name
    // is a tossed or stale cookie, not a session to extend.
    if (org.slug !== slug) throw new TenantMismatchProblem("The refresh token belongs to a different workspace")
    assertServing(org)

    const membership = await this.membershipOf(org, row.userId, "refresh session")
    if (membership === null) {
      await this.refreshTokens.revoke(row.id, now)
      throw new NotAuthenticatedProblem("The membership is no longer active")
    }
    // A requirement turned on since the last mint gates this one; the refresh token itself stays good.
    await this.assertSessionPolicy(org, membership, row.userId, row.ssoOrgId)

    // The scope rides along: a refresh never turns an SSO session into an ordinary one (ADR-0054).
    return this.mint(row.userId, org, membership, client, now, row.id, { ssoOrgId: row.ssoOrgId })
  }

  /** Idempotent: clearing what is not there is not an error. */
  async logout(input: LogoutInput): Promise<CookieName[]> {
    const now = this.clock.now()
    const clear: CookieName[] = []

    if (input.slug !== undefined) {
      if (input.refreshSecret !== undefined) {
        const row = await this.refreshTokens.findByHash(hash(input.refreshSecret))
        if (row !== null && row.orgId !== null) await this.refreshTokens.revoke(row.id, now)
      }
      clear.push(...this.cookies.pairOf(input.slug))
    }

    if (input.everywhere) {
      const identity = await this.identityFor(input.identitySecret)
      // An SSO session's "everywhere" is the one workspace it reaches, never the person's others (M13 review).
      if (identity?.ssoOrgId != null) clear.push(...(await this.revokeWithinScope(identity.userId, identity.ssoOrgId)))
      else if (identity !== null) clear.push(...(await this.revokeEverywhere(identity.userId)))
      else clear.push({ name: this.cookies.identity("").name, path: "/" })
    }

    return clear
  }

  private async tryOpen(
    userId: string,
    slug: string,
    client: ClientInfo,
    now: Date,
    ssoOrgId: string | null,
  ): Promise<CookieSpec[] | null> {
    const org = await this.organizations.bySlug(slug)
    if (org === null || org.status !== "ACTIVE") return null
    const membership = await this.membershipOf(org, userId, "login into workspace")
    if (membership === null || (await this.sessionRefusal(org, membership, userId, ssoOrgId)) !== null) return null
    return this.mint(userId, org, membership, client, now, undefined, { ssoOrgId })
  }

  /**
   * Who may open this workspace with this session, at open and at refresh —
   * never mid-session (ADR-0045, ADR-0053, ADR-0054):
   *
   * 1. An SSO session opens only the workspace whose identity provider started it.
   * 2. "SSO required" admits a non-owner only through that provider; owners
   *    keep their own credentials as the way back in when it is down.
   * 3. "Second factor required" is met by a factor of either kind, or by a
   *    session this workspace's provider started: it delegated the strength.
   */
  private async sessionRefusal(
    org: OrganizationSummary,
    membership: MembershipRecord,
    userId: string,
    ssoOrgId: string | null,
  ): Promise<Error | null> {
    if (ssoOrgId !== null && ssoOrgId !== org.id) return new SsoSessionScopedProblem()
    const viaSso = ssoOrgId === org.id
    if (org.requireSso && !viaSso && membership.role !== "OWNER") return new SsoRequiredProblem()
    if (org.requireMfa && !viaSso && (await this.mfa.methods(userId)).length === 0) return new MfaRequiredProblem()
    return null
  }

  private async assertSessionPolicy(org: OrganizationSummary, membership: MembershipRecord, userId: string, ssoOrgId: string | null): Promise<void> {
    const refusal = await this.sessionRefusal(org, membership, userId, ssoOrgId)
    if (refusal !== null) throw refusal
  }

  /**
   * The authoritative read (ADR-0031): the membership row, inside the tenant,
   * never the projection. `activeOnly` is relaxed only to find memberships to
   * revoke, where a disabled one still has an epoch worth bumping.
   */
  private membershipOf(
    org: OrganizationSummary,
    userId: string,
    reason: string,
    activeOnly = true,
  ): Promise<MembershipRecord | null> {
    return runAsTenant(org.id, { actor: `user:${userId}`, reason }, async () => {
      const membership = await this.memberships.findByUser(org.id, userId)
      if (membership === null || membership.kind !== "HUMAN") return null
      if (activeOnly && membership.status !== "ACTIVE") return null
      return membership
    })
  }

  private async mint(
    userId: string,
    org: OrganizationSummary,
    membership: MembershipRecord,
    client: ClientInfo,
    now: Date,
    rotating?: string,
    options: OpenOptions = {},
  ): Promise<CookieSpec[]> {
    const ssoOrgId = options.ssoOrgId ?? null
    const { token } = await this.accessTokens.sign({
      sub: userId,
      org: org.id,
      mem: membership.id,
      role: membership.role,
      ...(options.stepUpAt === undefined ? {} : { sua: Math.floor(options.stepUpAt.getTime() / 1000) }),
      ...(ssoOrgId === org.id ? { sso: true as const } : {}),
    })
    const secret = await this.issue(userId, org.id, client, now, rotating, ssoOrgId)
    return [this.cookies.access(org.slug, token), this.cookies.refresh(org.slug, secret)]
  }

  /** A new refresh token (or `pg_id`); returns the secret the cookie carries. */
  private async issue(
    userId: string,
    orgId: string | null,
    client: ClientInfo,
    now: Date,
    rotating?: string,
    ssoOrgId: string | null = null,
  ): Promise<string> {
    const secret = randomBytes(32).toString("base64url")
    const record = {
      userId,
      orgId,
      ssoOrgId,
      tokenHash: hash(secret),
      expiresAt: new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      userAgent: client.userAgent,
      ip: client.ip,
    }
    if (rotating === undefined) await this.refreshTokens.create(record)
    else await this.refreshTokens.rotate(rotating, record, now)
    return secret
  }
}

/** Random 256-bit secrets are hashed with SHA-256 and looked up by hash; Argon2id is for low-entropy secrets. */
export const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex")

const isUsable = (account: AccountRecord): boolean =>
  account.anonymisedAt === null && account.emailVerifiedAt !== null

const isLive = (row: { revokedAt: Date | null; expiresAt: Date }, now: Date): boolean =>
  row.revokedAt === null && row.expiresAt.getTime() > now.getTime()

function assertServing(org: OrganizationSummary): void {
  if (org.status === "SUSPENDED") throw new OrganizationSuspendedProblem("This workspace is suspended")
  if (org.status === "PENDING_DELETION" || org.status === "DELETED") throw new NotFoundProblem("Unknown workspace")
}
