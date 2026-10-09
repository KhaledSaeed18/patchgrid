import { ROOT_DOMAIN } from "./config"
import { parseHost } from "./host"

/**
 * Where to go after signing in, from a `?next=` the browser carried here.
 * Only a path on this host, or an absolute URL on one of OUR hosts, is
 * accepted — anything else would make the login page an open redirect.
 */
export type NextTarget =
  | { kind: "path"; path: string }
  | { kind: "workspace"; slug: string; url: string }

export function parseNext(next: string | null | undefined): NextTarget | null {
  if (next === null || next === undefined || next === "") return null
  if (
    next.startsWith("/") &&
    !next.startsWith("//") &&
    !next.startsWith("/\\")
  ) {
    return { kind: "path", path: next }
  }
  let url: URL
  try {
    url = new URL(next)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  const host = parseHost(url.host, ROOT_DOMAIN)
  if (host.kind === "tenant")
    return { kind: "workspace", slug: host.slug, url: url.toString() }
  if (host.kind === "app")
    return { kind: "path", path: url.pathname + url.search }
  return null
}
