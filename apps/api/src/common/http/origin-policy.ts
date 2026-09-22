import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from "@patchgrid/contracts"

/**
 * Which browser origins may call the API with credentials.
 *
 * This is security-critical and easy to get subtly wrong, so it is a pure
 * function with its own tests rather than a regex inlined into `main.ts`.
 *
 * Tenants are addressed by subdomain (ADR-0014), so the allow-list cannot be
 * static — it is "the apex, a few named infrastructure hosts, and any host whose
 * single leading label is a well-formed slug".
 */
export type OriginPolicy = {
  /** The registrable domain: `patchgrid.xyz`, or `lvh.me` locally. */
  readonly rootDomain: string
  /** Development only. Production origins are https. */
  readonly allowHttp: boolean
  /** Development only. Empty means "no port", which is what production sends. */
  readonly allowedPorts: readonly number[]
}

/**
 * Hosts that are not tenants but are still ours. They are deliberately *not*
 * validated as slugs, because every one of them is in `RESERVED_SLUGS` and would
 * therefore fail slug validation — which is the point of reserving them.
 *
 * `api` is absent: the API does not call itself from a browser.
 */
const INFRASTRUCTURE_LABELS: ReadonlySet<string> = new Set(["www", "app", "admin"])

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // Includes the literal string "null", which sandboxed iframes send.
    return false
  }

  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return false
  }

  // An origin never carries a path, query or credentials. Anything that parsed
  // into one is not an origin, whatever it looks like.
  if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.hash !== "") {
    return false
  }

  if (url.port === "") {
    if (policy.allowedPorts.length > 0 && policy.allowHttp) return false
  } else if (!policy.allowedPorts.includes(Number(url.port))) {
    return false
  }

  const host = url.hostname.toLowerCase()
  const root = policy.rootDomain.toLowerCase()

  if (host === root) return true

  // Anchored suffix match. `acme.patchgrid.xyz.evil.com` ends with `evil.com`,
  // and `notpatchgrid.xyz` does not end with `.patchgrid.xyz` — both rejected.
  const suffix = `.${root}`
  if (!host.endsWith(suffix)) return false

  const label = host.slice(0, -suffix.length)

  // Exactly one label. `a.b.patchgrid.xyz` is not a tenant, and the wildcard
  // certificate would not cover it anyway (docs/DNS.md §1).
  if (label === "" || label.includes(".")) return false

  if (INFRASTRUCTURE_LABELS.has(label)) return true

  return (
    label.length >= SLUG_MIN_LENGTH &&
    label.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(label)
  )
}

/** The callback shape Nest's CORS options expect. */
export function corsOriginCallback(policy: OriginPolicy) {
  return (
    origin: string | undefined,
    callback: (error: Error | null, allow?: boolean) => void,
  ): void => {
    // Same-origin and server-to-server requests send no Origin. They are not
    // subject to CORS at all; the tenant binding still comes from the credential
    // (ADR-0024), so allowing them here grants nothing.
    if (origin === undefined) {
      callback(null, true)
      return
    }
    callback(null, isAllowedOrigin(origin, policy))
  }
}
