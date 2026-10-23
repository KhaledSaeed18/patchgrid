import { type CanActivate, type ExecutionContext, Injectable, Logger } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { API_TOKEN_PATTERN, supportCookieName } from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { ClsService } from "nestjs-cls"

import { ApiTokenVerifier } from "../api-tokens/api-token-verifier"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ALLOWS_SSO_SESSION, IS_PLATFORM, IS_PUBLIC, IS_TENANT_OPTIONAL } from "../common/decorators/route-markers"
import { originPolicyFrom } from "../common/http/origin-policy"
import { InjectConfig, type AppConfig } from "../config/app-config"
import { PlatformAdminRepository } from "../platform/repositories/platform-admin.repository"
import { statusOf } from "../support/domain"
import { SupportSessionRepository } from "../support/repositories/support-session.repository"
import { SupportMail } from "../support/support-mail"
import {
  NotAuthenticatedProblem,
  NotPermittedProblem,
  ServiceUnavailableProblem,
  SsoSessionScopedProblem,
  TenantMismatchProblem,
} from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { type RequestContextStore, TenantContextMissingError } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import type { Actor } from "./actor"
import { readCookie } from "./cookies"
import { platformEpochKey } from "./platform/platform-auth.service"
import { PlatformTokenService } from "./platform/platform-token.service"
import { fromAdminSurface, PLATFORM_SESSION_COOKIE } from "./platform/surface"
import { orgEpochKey, RevocationEpochService } from "./revocation/revocation-epoch.service"
import { SupportReadLog } from "./support/support-read-log"
import { supportEpochKey, SupportTokenService } from "./support/support-token.service"
import { SessionService } from "./sessions/session.service"
import { accessCookieName, IDENTITY_COOKIE } from "./tokens/access-token"
import { AccessTokenService } from "./tokens/access-token.service"

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Pipeline step 7: the credential tenant resolution routed on is now VERIFIED,
 * exactly once, and becomes the `Actor`.
 *
 * - `@Public`: no actor.
 * - `@TenantOptional`: `pg_id` → an `identity` actor. The org picker's routes.
 * - Bearer: an API token whose prefix resolved this org → its row, its
 *   service account and its secret, every request (ADR-0042). Cookies unread.
 * - Tenant-bound: the access cookie named by the resolved slug → signature,
 *   expiry, that its `org` is the resolved org (403 otherwise), the revocation
 *   epoch, and the membership row itself — read inside the tenant, so a
 *   disabled member is out on the next request even if Redis is not.
 *
 * Epoch unavailable (Redis down): reads proceed and are logged, mutations get a
 * 503 — the trade ADR-0024 §5 states and threat model R-3 records.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly tenantContext: TenantContextService,
    private readonly accessTokens: AccessTokenService,
    private readonly epochs: RevocationEpochService,
    private readonly sessions: SessionService,
    private readonly memberships: MembershipRepository,
    private readonly platformTokens: PlatformTokenService,
    private readonly platformAdmins: PlatformAdminRepository,
    private readonly supportTokens: SupportTokenService,
    private readonly supportSessions: SupportSessionRepository,
    private readonly supportMail: SupportMail,
    private readonly supportReadLog: SupportReadLog,
    private readonly apiTokens: ApiTokenVerifier,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true) return true

    const request = context.switchToHttp().getRequest<Request>()

    if (this.reflector.getAllAndOverride<boolean>(IS_PLATFORM, targets) === true) return this.platform(request)

    if (this.reflector.getAllAndOverride<boolean>(IS_TENANT_OPTIONAL, targets) === true) {
      const identity = await this.sessions.identityFor(readCookie(request, IDENTITY_COOKIE))
      if (identity === null) throw new NotAuthenticatedProblem("A session is required")
      // An identity provider vouched for one workspace, not for the account (ADR-0054): deny by default.
      if (identity.ssoOrgId !== null && this.reflector.getAllAndOverride<boolean>(ALLOWS_SSO_SESSION, targets) !== true) {
        throw new SsoSessionScopedProblem("This session came from a workspace's single sign-on; sign in with your Patchgrid credentials for account changes")
      }
      this.setActor({ kind: "identity", userId: identity.userId, ssoOrgId: identity.ssoOrgId })
      return true
    }

    const organization = this.tenantContext.organization()
    if (organization === undefined) {
      // A tenant-bound route that resolution did not run on: a wiring bug, not a client error.
      throw new TenantContextMissingError("Authentication")
    }

    if (organization.via === "bearer") return this.bearer(request, organization.id)

    // An operator's support session in this workspace (ADR-0041), preferred as resolution preferred it.
    const supportToken = readCookie(request, supportCookieName(organization.slug))
    if (supportToken !== undefined) {
      return this.support(request, context.switchToHttp().getResponse<Response>(), organization.id, supportToken)
    }

    const token = readCookie(request, accessCookieName(organization.slug))
    const claims = token === undefined ? null : await this.accessTokens.verify(token)
    if (claims === null) throw new NotAuthenticatedProblem("A session is required")
    if (claims.org !== organization.id) {
      throw new TenantMismatchProblem("The session belongs to a different workspace")
    }

    const revoked = await this.epochs.isRevoked(claims.mem, claims.iat)
    if (revoked === true) throw new NotAuthenticatedProblem("The session was revoked")
    if (revoked === null) {
      if (!SAFE_METHODS.has(request.method)) {
        throw new ServiceUnavailableProblem("The session could not be confirmed; retry shortly")
      }
      this.logger.warn({ msg: "revocation epoch unavailable, read allowed", membershipId: claims.mem })
    }

    // Inside the tenant context resolution established, so RLS scopes this read.
    const membership = await this.memberships.findById(organization.id, claims.mem)
    if (membership === null || membership.status !== "ACTIVE" || membership.userId !== claims.sub) {
      throw new NotAuthenticatedProblem("The membership is no longer active")
    }

    this.cls.set("credential", { issuedAt: claims.iat, expiresAt: claims.exp })
    this.setActor({
      kind: "member",
      userId: claims.sub,
      orgId: organization.id,
      membershipId: membership.id,
      role: membership.role,
      teamIds: membership.teamIds,
      leadOfTeamIds: membership.leadOfTeamIds,
      ...(claims.sua === undefined ? {} : { stepUpAt: claims.sua }),
      ...(claims.sso === true ? { viaSso: true as const } : {}),
    })
    return true
  }

  /**
   * An API token (ADR-0021, ADR-0042), inside the org its prefix resolved to:
   * the row, its service account and its secret, on every request. A token is
   * an actor, never a bypass — what it may do is its role ∩ its scopes.
   */
  private async bearer(request: Request, orgId: string): Promise<boolean> {
    const [, token] = request.headers.authorization?.trim().split(/\s+/) ?? []
    const match = token === undefined ? null : API_TOKEN_PATTERN.exec(token)
    if (match?.[1] === undefined || match[2] === undefined) throw new NotAuthenticatedProblem("The bearer token is not a Patchgrid API token")
    const actor = await this.apiTokens.verify(orgId, match[1], match[2])
    if (actor === null) throw new NotAuthenticatedProblem("The API token is not valid")
    // Deletion requested: every token is out at once, whatever the cached summary still says (THREAT-MODEL §7).
    const suspended = await this.epochs.isRevoked(orgEpochKey(orgId), 0)
    if (suspended === true) throw new NotAuthenticatedProblem("The workspace is pending deletion")
    if (suspended === null && !SAFE_METHODS.has(request.method)) {
      throw new ServiceUnavailableProblem("The token could not be confirmed; retry shortly")
    }
    this.setActor(actor)
    return true
  }

  /**
   * A support session on the tenant's own routes (ADR-0041): the token, the
   * epoch, then the session row itself — granted, not ended, not expired,
   * this operator — and the operator's grant, all on every request. From the
   * moment the actor is known, the request's outcome is recorded, whatever it
   * is; a write is then refused before any handler runs.
   */
  private async support(request: Request, response: Response, orgId: string, token: string): Promise<boolean> {
    const claims = await this.supportTokens.verify(token)
    if (claims === null) throw new NotAuthenticatedProblem("The support session is not valid")
    if (claims.orgId !== orgId) throw new TenantMismatchProblem("The support session belongs to a different workspace")
    if ((await this.epochs.isRevoked(supportEpochKey(claims.sessionId), claims.iat)) === true) {
      throw new NotAuthenticatedProblem("The support session was ended")
    }
    const now = this.clock.now()
    const session = await this.supportSessions.find(orgId, claims.sessionId)
    if (session === null || session.platformAdminId !== claims.platformAdminId || statusOf(session, now) !== "ACTIVE") {
      throw new NotAuthenticatedProblem("The support session has ended")
    }
    // Signing out of the back-office ends support too (ADR-0041: whichever ends first).
    if ((await this.epochs.isRevoked(platformEpochKey(claims.platformAdminId), claims.iat)) === true) {
      throw new NotAuthenticatedProblem("The platform session was ended")
    }
    const admin = await this.platformAdmins.active(claims.platformAdminId)
    if (admin?.userId !== claims.userId || issuedBefore(claims.iat, admin.grantedAt)) {
      throw new NotAuthenticatedProblem("The platform grant is no longer active")
    }
    const actor = {
      kind: "support" as const,
      orgId,
      sessionId: claims.sessionId,
      platformAdminId: claims.platformAdminId,
      userId: claims.userId,
      role: "ADMIN" as const,
      membershipId: claims.sessionId,
    }
    this.setActor(actor)
    // From here every outcome is recorded — this refusal, any other guard's, the handler's answer.
    this.supportReadLog.watch(actor, request, response)
    if (!SAFE_METHODS.has(request.method)) throw new NotPermittedProblem("A support session is read-only")
    // The owners hear about the first read as it happens (ADR-0020).
    if (await this.supportSessions.markFirstUse(orgId, claims.sessionId, now)) {
      await this.supportMail.tell(orgId, "first-use", { id: claims.sessionId, operatorName: admin.name }, `It runs until ${session.expiresAt?.toUTCString() ?? "it is ended"}.`)
    }
    return true
  }

  /**
   * A platform route (ADR-0040): only `pg_pa`, only from the `admin.`
   * surface, then the epoch and the admin row itself — a revoked grant is out
   * on the next request, whatever the token says. Tenant cookies are never
   * read here.
   */
  private async platform(request: Request): Promise<boolean> {
    if (!fromAdminSurface(request, originPolicyFrom(this.config))) {
      throw new NotPermittedProblem("Platform routes answer only the admin surface")
    }
    const token = readCookie(request, PLATFORM_SESSION_COOKIE)
    const session = token === undefined ? null : await this.platformTokens.verifySession(token)
    if (session === null) throw new NotAuthenticatedProblem("A platform session is required")
    const revoked = await this.epochs.isRevoked(platformEpochKey(session.platformAdminId), session.iat)
    if (revoked === true) throw new NotAuthenticatedProblem("The session was ended")
    if (revoked === null && !SAFE_METHODS.has(request.method)) {
      throw new ServiceUnavailableProblem("The session could not be confirmed; retry shortly")
    }
    const admin = await this.platformAdmins.active(session.platformAdminId)
    if (admin?.userId !== session.userId || issuedBefore(session.iat, admin.grantedAt)) {
      throw new NotAuthenticatedProblem("The platform grant is no longer active")
    }
    this.setActor({ kind: "platform", platformAdminId: admin.id, userId: admin.userId, sessionExpiresAt: session.exp })
    return true
  }

  private setActor(actor: Actor): void {
    this.cls.set("actor", actor)
  }
}

/** Issued under an earlier grant: a revoke and a re-grant must not bring old tokens back. */
function issuedBefore(iat: number, grantedAt: Date): boolean {
  return iat < Math.floor(grantedAt.getTime() / 1000)
}
