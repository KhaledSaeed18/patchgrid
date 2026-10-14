import { parseHost } from "./host"
import { needsRefresh } from "./session"

/**
 * The proxy's whole decision, as a pure function (ADR-0014, ADR-0035), so it is
 * tested as a table rather than through a running server.
 *
 * - `app.` serves the tenant-less pages; the picker and workspace creation
 *   need the identity cookie, the rest are public.
 * - `<slug>.` serves the workspace. No session at all → login on `app.`, with
 *   the way back. An access token missing or about to lapse, with an identity
 *   to refresh from → `/session/refresh` first.
 * - `admin.` serves the back-office (ADR-0040), rewritten under `/backoffice`
 *   so its `/login` is not `app.`'s. Its session cookie is scoped to the
 *   API's platform routes and never reaches this server, so the pages are
 *   client-rendered and the API alone decides who may see them.
 * - Anything else is not ours.
 */

/** Pages of the tenant-less surface, and which of them need a signed-in identity. */
const APP_PATHS: Record<string, "public" | "identity"> = {
  "/login": "public",
  "/reset-password": "public",
  "/verify-email": "public",
  "/invite": "public",
  "/workspaces": "identity",
  "/new": "identity",
}

/** The back-office's pages, under the internal prefix only `admin.` is rewritten to. */
export const BACKOFFICE_PREFIX = "/backoffice"
const ADMIN_PATHS: ReadonlySet<string> = new Set(["/login", "/orgs"])

/** Set by the proxy only — a client that sends them has them overwritten — and read by server components. */
export const SLUG_HEADER = "x-patchgrid-slug"
export const PATH_HEADER = "x-patchgrid-path"

/** Where the browser refreshes its own token; reachable without one, by definition. */
export const REFRESH_PATH = "/session/refresh"

export type RouteInput = {
  host: string | null
  /** This request's own origin, for the way back after login. */
  origin: string
  pathname: string
  search: string
  /** The `pg_at_<slug>` value for the host's slug, and `pg_id`, if present. */
  cookies: (name: string) => string | undefined
  nowSeconds: number
  rootDomain: string
  appOrigin: string
}

export type RouteDecision =
  | { kind: "next"; slug: string | null }
  | { kind: "redirect"; to: string }
  | { kind: "rewrite"; to: string }
  | { kind: "not-found" }

export function decideRoute(input: RouteInput): RouteDecision {
  const host = parseHost(input.host, input.rootDomain)
  const page = topLevel(input.pathname)
  const hasIdentity = input.cookies("pg_id") !== undefined

  if (host.kind === "foreign") return { kind: "not-found" }
  // The back-office prefix is an internal name, reachable only through admin.'s rewrite.
  if (page === BACKOFFICE_PREFIX) return { kind: "not-found" }

  if (host.kind === "admin") {
    if (input.pathname === "/") return { kind: "redirect", to: "/orgs" }
    if (!ADMIN_PATHS.has(page)) return { kind: "not-found" }
    return {
      kind: "rewrite",
      to: `${BACKOFFICE_PREFIX}${input.pathname}${input.search}`,
    }
  }

  if (host.kind === "app") {
    if (input.pathname === "/")
      return { kind: "redirect", to: hasIdentity ? "/workspaces" : "/login" }
    const access = APP_PATHS[page]
    if (access === undefined) return { kind: "not-found" }
    if (access === "identity" && !hasIdentity) {
      return {
        kind: "redirect",
        to: `/login?next=${encodeURIComponent(input.pathname + input.search)}`,
      }
    }
    return { kind: "next", slug: null }
  }

  // A workspace host asked for a tenant-less page: send it to app., where it lives.
  if (APP_PATHS[page] !== undefined)
    return {
      kind: "redirect",
      to: `${input.appOrigin}${input.pathname}${input.search}`,
    }
  if (input.pathname === REFRESH_PATH) return { kind: "next", slug: host.slug }

  // An operator's support session (ADR-0041): its token runs to the session's end and is never refreshed.
  if (input.cookies(`pg_st_${host.slug}`) !== undefined)
    return { kind: "next", slug: host.slug }

  const back = input.pathname + input.search
  const access = input.cookies(`pg_at_${host.slug}`)
  if (access === undefined && !hasIdentity) {
    return {
      kind: "redirect",
      to: `${input.appOrigin}/login?next=${encodeURIComponent(input.origin + back)}`,
    }
  }
  if (needsRefresh(access, input.nowSeconds)) {
    return {
      kind: "redirect",
      to: `${REFRESH_PATH}?next=${encodeURIComponent(back)}`,
    }
  }
  return { kind: "next", slug: host.slug }
}

function topLevel(pathname: string): string {
  const [, first = ""] = pathname.split("/")
  return `/${first}`
}
