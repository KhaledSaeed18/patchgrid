import { Injectable, type NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"

import { ActorService } from "../auth/actor"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { recordHttpRequest, recordTransactionsPerRequest, tagActiveSpanWithTenant } from "./metrics"

/**
 * Per-request telemetry at the HTTP edge (ADR-0030): the duration by route,
 * status and tenant, how many transactions the request opened, and the tenant
 * on the request's span. Measured on `finish`, inside the request context the
 * guards populated, so a refusal from a guard is counted like any other
 * answer — an interceptor would miss those.
 */
@Injectable()
export class TelemetryMiddleware implements NestMiddleware {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly actors: ActorService,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = process.hrtime.bigint()
    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000
      const route = routeOf(request)
      const orgId = this.tenant.current()?.orgId
      const actor = this.actors.current()
      tagActiveSpanWithTenant({
        orgId,
        membershipId: actor !== undefined && "membershipId" in actor ? actor.membershipId : undefined,
        actorKind: actor?.kind,
      })
      recordHttpRequest({ method: request.method, route, status: response.statusCode, orgId, durationMs })
      recordTransactionsPerRequest(this.tenant.transactionsThisRequest(), route)
    })
    next()
  }
}

/** The route pattern, never the URL: `/api/v1/tickets/:id`, not one series per ticket. */
function routeOf(request: Request & { route?: { path?: string } }): string {
  const pattern = request.route?.path
  if (typeof pattern !== "string") return "unmatched"
  return `${request.baseUrl}${pattern}`
}
