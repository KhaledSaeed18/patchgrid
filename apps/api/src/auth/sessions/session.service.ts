import { Inject, Injectable, Logger } from "@nestjs/common"
import type { LoginResponse } from "@patchgrid/contracts"
import { createHash, randomBytes } from "node:crypto"

import { type Clock, InjectClock } from "../../common/clock/clock"
import {
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
import type { OrganizationSummary } from "../../platform/repositories/organization.repository"
import { RefreshTokenRepository } from "../../platform/repositories/refresh-token.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { type AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "../../tenancy/organization-lookup"
import { type CookieName, CookieService, type CookieSpec } from "../cookies"
import { PasswordService } from "../passwords/password.service"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { AccessTokenService } from "../tokens/access-token.service"

/** Where the credential is being used from — recorded on the refresh token, never logged. */
export type ClientInfo = { userAgent: string | null; ip: string | null }

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

    const now = this.clock.now()
    const identity = await this.issue(account.id, null, client, now)
    await this.users.touchLastLogin(account.id, now)
    const cookies: CookieSpec[] = [this.cookies.identity(identity)]

    let session: LoginResponse["session"] = null
    if (slug !== undefined) {
      const pair = await this.tryOpen(account.id, slug, client, now)
      if (pair !== null) {
        cookies.push(...pair)
        session = { slug }
      }
    }

    return {
      response: {
        user: { id: account.id, email: account.email, name: account.name },
        workspaces: await this.workspaces.listWorkspacesForUser(account.id),
        session,
      },
      cookies,
    }
  }

  /** The org switcher: a `pg_id` holder opens one workspace they belong to. */
  async open(userId: string, slug: string, client: ClientInfo): Promise<CookieSpec[]> {
    const org = await this.organizations.bySlug(slug)
    if (org === null) throw new NotFoundProblem("Unknown workspace")
    assertServing(org)
    const membership = await this.membershipOf(org, userId, "open session")
    if (membership === null) {
      throw new NotPermittedProblem("You are not a member of this workspace")
    }
    return this.mint(userId, org, membership, client, this.clock.now())
  }

  /** `pg_id` → the user it identifies, or `null` for anything invalid. */
  async identityFor(secret: string | undefined): Promise<string | null> {
    if (secret === undefined) return null
    const row = await this.refreshTokens.findByHash(hash(secret))
    if (row === null || row.orgId !== null || !isLive(row, this.clock.now())) return null
    return row.userId
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

    return this.mint(row.userId, org, membership, client, now, row.id)
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
      const userId = await this.identityFor(input.identitySecret)
      if (userId !== null) {
        await this.refreshTokens.revokeAllForUser(userId, now)
        // Access tokens are stateless; the epoch is what ends them now rather
        // than in fifteen minutes. The projection only tells us where to look.
        for (const workspace of await this.workspaces.listWorkspacesForUser(userId)) {
          const org = await this.organizations.byId(workspace.orgId)
          if (org === null) continue
          const membership = await this.membershipOf(org, userId, "log out everywhere", false)
          if (membership !== null) await this.epochs.bump(membership.id)
          clear.push(...this.cookies.pairOf(org.slug))
        }
      }
      clear.push({ name: this.cookies.identity("").name, path: "/" })
    }

    return clear
  }

  private async tryOpen(
    userId: string,
    slug: string,
    client: ClientInfo,
    now: Date,
  ): Promise<CookieSpec[] | null> {
    const org = await this.organizations.bySlug(slug)
    if (org === null || org.status !== "ACTIVE") return null
    const membership = await this.membershipOf(org, userId, "login into workspace")
    return membership === null ? null : this.mint(userId, org, membership, client, now)
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
  ): Promise<CookieSpec[]> {
    const { token } = await this.accessTokens.sign({
      sub: userId,
      org: org.id,
      mem: membership.id,
      role: membership.role,
    })
    const secret = await this.issue(userId, org.id, client, now, rotating)
    return [this.cookies.access(org.slug, token), this.cookies.refresh(org.slug, secret)]
  }

  /** A new refresh token (or `pg_id`); returns the secret the cookie carries. */
  private async issue(
    userId: string,
    orgId: string | null,
    client: ClientInfo,
    now: Date,
    rotating?: string,
  ): Promise<string> {
    const secret = randomBytes(32).toString("base64url")
    const record = {
      userId,
      orgId,
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
  if (org.status === "PENDING_DELETION") throw new NotFoundProblem("Unknown workspace")
}
