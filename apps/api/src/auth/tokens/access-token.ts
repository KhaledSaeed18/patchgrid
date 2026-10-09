import { idSchema, roleSchema } from "@patchgrid/contracts"
import { z } from "zod"

/** The access token (ADR-0024). The cookies that carry it are named in `@patchgrid/contracts`. */
export {
  ACCESS_COOKIE_PREFIX,
  accessCookieName,
  IDENTITY_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_PREFIX,
  refreshCookieName,
} from "@patchgrid/contracts"

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
  /** Random per token, so two mints in one second are still two tokens and logs can tell them apart. */
  jti: z.uuid().optional(),
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
