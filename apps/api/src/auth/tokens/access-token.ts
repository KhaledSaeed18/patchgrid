import { idSchema, roleSchema } from "@patchgrid/contracts"
import { z } from "zod"

/**
 * The access token and the cookies that carry it (ADR-0024).
 *
 * Cookies are per tenant — `pg_at_<slug>` — so two workspaces can be open in
 * two tabs without fighting over one cookie. The slug is in the NAME, which is
 * what lets a slug change re-mint under the new name and expire the old one in
 * one response.
 */
export const ACCESS_COOKIE_PREFIX = "pg_at_"
export const REFRESH_COOKIE_PREFIX = "pg_rt_"
/** Tenant-less identity, a `RefreshToken` row with `orgId = NULL` (ADR-0031). */
export const IDENTITY_COOKIE = "pg_id"

export const accessCookieName = (slug: string): string => `${ACCESS_COOKIE_PREFIX}${slug}`
export const refreshCookieName = (slug: string): string => `${REFRESH_COOKIE_PREFIX}${slug}`

/** Bound to exactly one organization (TENANCY.md §6). */
export const accessTokenClaimsSchema = z.object({
  /** userId */
  sub: idSchema,
  /** orgId — the tenant. */
  org: idSchema,
  /** membershipId — what the revocation epoch is keyed on. */
  mem: idSchema,
  role: roleSchema,
  iat: z.int(),
  exp: z.int(),
})
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>

const orgClaimSchema = z.object({ org: idSchema })

/**
 * Reads the `org` claim WITHOUT verifying the signature.
 *
 * This is pipeline step 4 (ARCHITECTURE.md): the claim routes the request to a
 * tenant so resolution can run before authentication; it is trusted for nothing
 * until step 7 checks the signature, and a forged claim buys an attacker exactly
 * what an anonymous slug probe does (threat model R-2). Any malformed token is
 * `null`, which resolution turns into 401.
 */
export function peekOrgClaim(token: string): string | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))
    const parsed = orgClaimSchema.safeParse(payload)
    return parsed.success ? parsed.data.org : null
  } catch {
    return null
  }
}
