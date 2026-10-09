import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common"
import { REQUESTED_WITH } from "@patchgrid/contracts"
import type { Request } from "express"

import { NotPermittedProblem } from "../common/problems/problem.exception"

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * CSRF (ADR-0024 §4). Subdomains are same-site, so `SameSite=Lax` does not
 * separate `evil-tenant.patchgrid.xyz` from `acme.patchgrid.xyz`. A custom
 * header does: a cross-site form cannot set one, and a script that tries
 * triggers a CORS preflight the API controls. Required on every mutating
 * request that could ride on cookies — including login, where the attack is
 * logging the victim into the attacker's account.
 *
 * Bearer-token requests are exempt: a token in a header cannot be sent by a
 * browser on the attacker's behalf, which is the whole threat.
 */
@Injectable()
export class RequestedWithGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    if (SAFE_METHODS.has(request.method)) return true
    if (typeof request.headers.authorization === "string") return true
    if (request.headers["x-requested-with"] === REQUESTED_WITH) return true
    throw new NotPermittedProblem("Mutating requests must carry X-Requested-With: patchgrid")
  }
}
