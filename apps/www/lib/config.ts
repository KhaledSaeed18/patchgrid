/**
 * Where the rest of Patchgrid lives, from the marketing site (ADR-0014). Public
 * by nature; the development defaults mean a fresh checkout needs no `.env`.
 */
export const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "lvh.me"
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://api.lvh.me:4000/api/v1"
const PROTOCOL = process.env.NEXT_PUBLIC_PROTOCOL ?? "http"
/** Empty in production, where everything is on 443. */
const APP_PORT = process.env.NEXT_PUBLIC_APP_PORT ?? "3001"
const MARKETING_PORT = process.env.NEXT_PUBLIC_MARKETING_PORT ?? "3000"

const withPort = (host: string, port: string) =>
  `${PROTOCOL}://${host}${port === "" ? "" : `:${port}`}`

/**
 * This site's own origin: the base for canonical URLs, the sitemap and every
 * Open Graph image, which crawlers need absolute.
 */
export const SITE_URL = withPort(ROOT_DOMAIN, MARKETING_PORT)

/** The repository the docs and the blog link into; the code is the reference. */
export const REPO_URL = "https://github.com/KhaledSaeed18/patchgrid"

/** `app.` — sign in, the workspace picker, creating a workspace. */
export const appUrl = (path = "/"): string =>
  `${withPort(`app.${ROOT_DOMAIN}`, APP_PORT)}${path}`

/**
 * The workspace a visitor chose while signing up, carried to `app.` for after
 * their email is verified. Not a reservation and not a secret: a name and an
 * address, readable by every Patchgrid host, gone within a day.
 */
export const PENDING_WORKSPACE_COOKIE = "pg_pending_workspace"
