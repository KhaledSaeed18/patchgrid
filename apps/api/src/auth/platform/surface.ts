import { ADMIN_SURFACE, SURFACE_HEADER } from "@patchgrid/contracts"
import type { Request } from "express"

import { classifyOrigin, type OriginPolicy } from "../../common/http/origin-policy"

/** The platform cookies' paths: the session reaches only the platform routes, the challenge only its login (ADR-0040). */
export const PLATFORM_SESSION_COOKIE = "pg_pa"
export const PLATFORM_SESSION_PATH = "/api/v1/platform"
export const PLATFORM_CHALLENGE_COOKIE = "pg_pch"
export const PLATFORM_CHALLENGE_PATH = "/api/v1/platform/auth"

/**
 * Whether a request speaks for the `admin.` surface — a cross-check on the
 * platform credential, as a tenant `Origin` is on a tenant's (ADR-0040). A
 * browser says so with `Origin`; a server, which sends none, with
 * `X-Patchgrid-Surface`. An `Origin` that names anything else is a no,
 * whatever the header says.
 */
export function fromAdminSurface(request: Pick<Request, "headers">, policy: OriginPolicy): boolean {
  const origin = request.headers.origin
  const surface = request.headers[SURFACE_HEADER]
  if (typeof origin === "string") {
    const kind = classifyOrigin(origin, policy)
    return kind.kind === "infrastructure" && kind.label === ADMIN_SURFACE
  }
  return surface === ADMIN_SURFACE
}
