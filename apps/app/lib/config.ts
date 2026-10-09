/**
 * Where everything lives, from the browser's point of view (ADR-0014). Public
 * by nature — every value here is a hostname the user's browser already sees —
 * so `NEXT_PUBLIC_` is correct, and the development defaults mean a fresh
 * checkout needs no `.env` in this package.
 */

/** `lvh.me` locally (wildcard DNS to 127.0.0.1); `patchgrid.xyz` in production. */
export const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "lvh.me"

/** The API, including its version prefix. Browsers and the Next server both call it directly (ADR-0007). */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://api.lvh.me:4000/api/v1"

const PROTOCOL = process.env.NEXT_PUBLIC_PROTOCOL ?? "http"
/** Empty in production, where everything is on 443. */
const APP_PORT = process.env.NEXT_PUBLIC_APP_PORT ?? "3001"
const MARKETING_PORT = process.env.NEXT_PUBLIC_MARKETING_PORT ?? "3000"

const withPort = (host: string, port: string) =>
  `${PROTOCOL}://${host}${port === "" ? "" : `:${port}`}`

/** `app.` — login, the picker, creating a workspace, accepting an invitation. */
export const appOrigin = (): string => withPort(`app.${ROOT_DOMAIN}`, APP_PORT)

/** `<slug>.` — a workspace. */
export const workspaceOrigin = (slug: string): string =>
  withPort(`${slug}.${ROOT_DOMAIN}`, APP_PORT)

/** The apex — the marketing site. */
export const marketingOrigin = (): string =>
  withPort(ROOT_DOMAIN, MARKETING_PORT)
