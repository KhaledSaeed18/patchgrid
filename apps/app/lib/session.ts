/**
 * Reading an access token's expiry WITHOUT verifying it (ADR-0035).
 *
 * Safe for exactly one purpose: deciding whether to send the browser through
 * the refresh page before rendering. It never grants anything — the API
 * verifies every token it is handed, and a forged `exp` here only buys the
 * forger a 401 from the API instead of a redirect from us.
 */
export function tokenExpiresAt(token: string): number | null {
  const [, payload] = token.split(".")
  if (payload === undefined) return null
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))
    if (typeof claims !== "object" || claims === null || !("exp" in claims) || typeof claims.exp !== "number") return null
    return claims.exp
  } catch {
    return null
  }
}

/** Refresh a little early, so a page does not start rendering on a token that lapses mid-render. */
export const REFRESH_SKEW_SECONDS = 60

export function needsRefresh(token: string | undefined, nowSeconds: number): boolean {
  if (token === undefined || token === "") return true
  const exp = tokenExpiresAt(token)
  return exp === null || exp - REFRESH_SKEW_SECONDS <= nowSeconds
}
