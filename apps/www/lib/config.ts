/**
 * Where the rest of Patchgrid lives, from the marketing site (ADR-0014). Public
 * by nature; the development defaults mean a fresh checkout needs no `.env`.
 */
export const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "lvh.me"
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://api.lvh.me:4000/api/v1"
const PROTOCOL = process.env.NEXT_PUBLIC_PROTOCOL ?? "http"
const APP_PORT = process.env.NEXT_PUBLIC_APP_PORT ?? "3001"

/** `app.` — sign in, the workspace picker, creating a workspace. */
export const appUrl = (path = "/"): string =>
  `${PROTOCOL}://app.${ROOT_DOMAIN}${APP_PORT === "" ? "" : `:${APP_PORT}`}${path}`

/**
 * The workspace a visitor chose while signing up, carried to `app.` for after
 * their email is verified. Not a reservation and not a secret: a name and an
 * address, readable by every Patchgrid host, gone within a day.
 */
export const PENDING_WORKSPACE_COOKIE = "pg_pending_workspace"
