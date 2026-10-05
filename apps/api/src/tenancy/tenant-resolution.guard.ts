import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Request } from "express"
import { ClsService } from "nestjs-cls"

import { IS_PUBLIC, IS_TENANT_OPTIONAL } from "../common/decorators/route-markers"
import { originPolicyFrom } from "../common/http/origin-policy"
import {
  NotAuthenticatedProblem,
  NotFoundProblem,
  OrganizationSuspendedProblem,
  type ProblemException,
  TenantMismatchProblem,
} from "../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../config/app-config"
import { locateCredential, TENANT_HEADER } from "./credential-locator"
import type { RequestContextStore } from "./request-context"
import { type Refusal, TenantResolver } from "./tenant-resolver"

/**
 * Pipeline step 4, realised as the first global guard.
 *
 * ARCHITECTURE.md calls it middleware, and conceptually it is: it runs before
 * authentication and before any handler. In Nest it has to be a guard, because
 * the routes that skip it are marked by decorator (`@Public`,
 * `@TenantOptional`) and middleware runs before the route is known. Guards run
 * inside the CLS context the middleware opened, which is what lets this one
 * write the tenant into it.
 *
 * On success the store holds `tenant` (what the Prisma client scopes by) and
 * `organization` (what the rest of the pipeline knows). On refusal the request
 * ends here with the status ADR-0024 assigns, and no handler sees it.
 */
@Injectable()
export class TenantResolutionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: TenantResolver,
    private readonly cls: ClsService<RequestContextStore>,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    const exempt =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) === true ||
      this.reflector.getAllAndOverride<boolean>(IS_TENANT_OPTIONAL, targets) === true
    if (exempt) return true

    const request = context.switchToHttp().getRequest<Request>()
    const located = locateCredential(
      {
        authorization: header(request, "authorization"),
        cookie: header(request, "cookie"),
        origin: header(request, "origin"),
        [TENANT_HEADER]: header(request, TENANT_HEADER),
      },
      originPolicyFrom(this.config),
    )

    const resolution = await this.resolver.resolve(located)
    if (!resolution.ok) throw problemFor(resolution.refusal)

    this.cls.set("tenant", { orgId: resolution.tenant.id, inTransaction: false })
    this.cls.set("organization", resolution.tenant)
    return true
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === "string" ? value : undefined
}

function problemFor(refusal: Refusal): ProblemException {
  switch (refusal.problem) {
    case "not-authenticated":
      return new NotAuthenticatedProblem(refusal.detail)
    case "tenant-mismatch":
      return new TenantMismatchProblem(refusal.detail)
    case "organization-suspended":
      return new OrganizationSuspendedProblem(refusal.detail)
    case "not-found":
      return new NotFoundProblem(refusal.detail)
  }
}
