/**
 * The workspace a visitor chose on the marketing site's signup form, carried
 * to `app.` in a cookie on the shared domain for after their email is
 * confirmed. A hint, not a reservation and not a secret; checked like
 * anything typed, and cleared once the workspace exists.
 */
export const PENDING_WORKSPACE_COOKIE = "pg_pending_workspace"

export type PendingWorkspace = { name: string; slug: string }

export function parsePendingWorkspace(
  raw: string | undefined
): PendingWorkspace | null {
  if (raw === undefined || raw === "") return null
  try {
    // Written URI-encoded; decoded here whether or not the cookie parser already did.
    const value: unknown = JSON.parse(
      raw.startsWith("%") ? decodeURIComponent(raw) : raw
    )
    if (typeof value !== "object" || value === null) return null
    const { name, slug } = value as Record<string, unknown>
    return typeof name === "string" && typeof slug === "string"
      ? { name: name.slice(0, 100), slug: slug.slice(0, 30) }
      : null
  } catch {
    return null
  }
}
