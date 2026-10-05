import { parse as parseCookies } from "cookie"

import { peekOrgClaim, accessCookieName } from "../auth/tokens/access-token"
import { classifyOrigin, type OriginClass, type OriginPolicy } from "../common/http/origin-policy"

/**
 * Where a request says it belongs — read, not yet believed.
 *
 * Pure: headers in, a structured description out. The decision about what to
 * DO with it is `TenantResolver`'s; the lookups are `OrganizationLookup`'s.
 * Keeping this a function makes the parsing rules the easy thing to test.
 */

export const TENANT_HEADER = "x-patchgrid-tenant"

/** `pg_<prefix>_<secret>` (ADR-0021). */
const BEARER_TOKEN = /^pg_([a-z0-9]+)_[A-Za-z0-9_-]+$/i

export type Credential =
  /** `Authorization: Bearer pg_…`. `prefix` is null when the token is not even well-formed. */
  | { kind: "bearer"; prefix: string | null }
  /** The access cookie named by the asserted slug. `orgId` is the UNVERIFIED claim, or null if unreadable. */
  | { kind: "cookie"; slug: string; orgId: string | null }
  | { kind: "none" }

export type Assertion = {
  origin: OriginClass | { kind: "absent" }
  /** `X-Patchgrid-Tenant`, sent by server-side callers that have no `Origin`. */
  header: string | null
}

export type Located = { credential: Credential; assertion: Assertion }

export type RequestHeaders = {
  authorization?: string | undefined
  cookie?: string | undefined
  origin?: string | undefined
  [TENANT_HEADER]?: string | undefined
}

/**
 * The slug the caller asserts, if the two ways of asserting it agree.
 * `undefined` means "none asserted"; `null` means "asserted twice, differently",
 * which the resolver treats as a mismatch.
 */
export function assertedSlug(assertion: Assertion): string | null | undefined {
  const fromOrigin = assertion.origin.kind === "tenant" ? assertion.origin.slug : undefined
  const fromHeader = assertion.header ?? undefined
  if (fromOrigin !== undefined && fromHeader !== undefined && fromOrigin !== fromHeader) return null
  return fromOrigin ?? fromHeader
}

export function locateCredential(headers: RequestHeaders, policy: OriginPolicy): Located {
  const origin = headers.origin === undefined ? { kind: "absent" as const } : classifyOrigin(headers.origin, policy)
  const headerValue = headers[TENANT_HEADER]?.trim().toLowerCase()
  const assertion: Assertion = {
    origin,
    header: headerValue === undefined || headerValue === "" ? null : headerValue,
  }

  // A bearer token is the tenant binding by itself; cookies are ignored
  // entirely when one is present (ADR-0024 §1).
  const authorization = headers.authorization?.trim()
  if (authorization !== undefined && authorization !== "") {
    const [scheme, token, ...rest] = authorization.split(/\s+/)
    if (scheme?.toLowerCase() !== "bearer" || token === undefined || rest.length > 0) {
      return { credential: { kind: "bearer", prefix: null }, assertion }
    }
    const match = BEARER_TOKEN.exec(token)
    return { credential: { kind: "bearer", prefix: match?.[1] ?? null }, assertion }
  }

  // Which cookie? The one named by the slug the request asserts. A cookie for
  // a different tenant is not a fallback; it is ignored (ADR-0024 §2).
  const slug = assertedSlug(assertion)
  if (slug === undefined || slug === null) return { credential: { kind: "none" }, assertion }

  const cookies = headers.cookie === undefined ? {} : parseCookies(headers.cookie)
  const token = cookies[accessCookieName(slug)]
  if (token === undefined || token === "") return { credential: { kind: "none" }, assertion }

  return { credential: { kind: "cookie", slug, orgId: peekOrgClaim(token) }, assertion }
}
