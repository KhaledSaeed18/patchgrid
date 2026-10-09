/**
 * The session cookies' names and paths (ADR-0024) — shared by the API, which
 * sets and reads them, and `apps/app`'s proxy, which decides where to send a
 * browser from whether they are present. One definition each.
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

/** Only the auth routes ever receive the refresh cookie (ADR-0004, ADR-0024) — never the Next server (ADR-0035). */
export const REFRESH_COOKIE_PATH = "/api/v1/auth"

export const accessCookieName = (slug: string): string => `${ACCESS_COOKIE_PREFIX}${slug}`
export const refreshCookieName = (slug: string): string => `${REFRESH_COOKIE_PREFIX}${slug}`

/** Every request a browser can send with cookies must carry this header (ADR-0024 §4). */
export const REQUESTED_WITH = "patchgrid"
/** The tenant a server-side caller asserts when it sends no `Origin` (ADR-0024 §1). */
export const TENANT_HEADER = "X-Patchgrid-Tenant"
