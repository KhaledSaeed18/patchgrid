import { type CanActivate, type ExecutionContext, Injectable, Logger } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Request } from "express"
import { ClsService } from "nestjs-cls"

import { IS_PUBLIC, IS_TENANT_OPTIONAL } from "../common/decorators/route-markers"
import {
  NotAuthenticatedProblem,
  ServiceUnavailableProblem,
  TenantMismatchProblem,
} from "../common/problems/problem.exception"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { type RequestContextStore, TenantContextMissingError } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import type { Actor } from "./actor"
import { readCookie } from "./cookies"
import { RevocationEpochService } from "./revocation/revocation-epoch.service"
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true) return true

    const request = context.switchToHttp().getRequest<Request>()

    if (this.reflector.getAllAndOverride<boolean>(IS_TENANT_OPTIONAL, targets) === true) {
      const userId = await this.sessions.identityFor(readCookie(request, IDENTITY_COOKIE))
      if (userId === null) throw new NotAuthenticatedProblem("A session is required")
      this.setActor({ kind: "identity", userId })
      return true
    }

    const organization = this.tenantContext.organization()
    if (organization === undefined) {
      // A tenant-bound route that resolution did not run on: a wiring bug, not a client error.
      throw new TenantContextMissingError("Authentication")
    }

    if (organization.via === "bearer") {
      // API tokens are an M8 item (ADR-0021); until then a prefix that resolves
      // still authenticates nothing.
      throw new NotAuthenticatedProblem("API tokens are not available yet")
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

    this.setActor({
      kind: "member",
      userId: claims.sub,
      orgId: organization.id,
      membershipId: membership.id,
      role: membership.role,
      teamIds: membership.teamIds,
      leadOfTeamIds: membership.leadOfTeamIds,
    })
    return true
  }

  private setActor(actor: Actor): void {
    this.cls.set("actor", actor)
  }
}
