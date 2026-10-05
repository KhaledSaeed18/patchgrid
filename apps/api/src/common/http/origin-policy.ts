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

/**
 * What an `Origin` header says about who is calling.
 *
 * - `tenant`: `<slug>.<root>` — the slug is the tenant the browser is acting
 *   in, which resolution cross-checks against the credential (ADR-0024).
 * - `infrastructure`: `www`, `app`, `admin` or the apex — ours, but no tenant.
 * - `foreign`: not ours, or not an origin at all. CORS refuses it credentials;
 *   resolution refuses it a tenant.
 */
export type OriginClass =
  | { kind: "tenant"; slug: string }
  | { kind: "infrastructure"; label: string }
  | { kind: "foreign" }

export function classifyOrigin(origin: string, policy: OriginPolicy): OriginClass {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // Includes the literal string "null", which sandboxed iframes send.
    return { kind: "foreign" }
  }

  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return { kind: "foreign" }
  }

  // An origin never carries a path, query or credentials. Anything that parsed
  // into one is not an origin, whatever it looks like.
  if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.hash !== "") {
    return { kind: "foreign" }
  }

  if (url.port === "") {
    if (policy.allowedPorts.length > 0 && policy.allowHttp) return { kind: "foreign" }
  } else if (!policy.allowedPorts.includes(Number(url.port))) {
    return { kind: "foreign" }
  }

  const host = url.hostname.toLowerCase()
  const root = policy.rootDomain.toLowerCase()

  if (host === root) return { kind: "infrastructure", label: "" }

  // Anchored suffix match. `acme.patchgrid.xyz.evil.com` ends with `evil.com`,
  // and `notpatchgrid.xyz` does not end with `.patchgrid.xyz` — both rejected.
  const suffix = `.${root}`
  if (!host.endsWith(suffix)) return { kind: "foreign" }

  const label = host.slice(0, -suffix.length)

  // Exactly one label. `a.b.patchgrid.xyz` is not a tenant, and the wildcard
  // certificate would not cover it anyway (docs/DNS.md §1).
  if (label === "" || label.includes(".")) return { kind: "foreign" }

  if (INFRASTRUCTURE_LABELS.has(label)) return { kind: "infrastructure", label }

  const isSlug =
    label.length >= SLUG_MIN_LENGTH && label.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(label)
  return isSlug ? { kind: "tenant", slug: label } : { kind: "foreign" }
}

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  return classifyOrigin(origin, policy).kind !== "foreign"
}

/** The one policy both CORS and tenant resolution apply, derived from config. */
export function originPolicyFrom(config: {
  readonly ROOT_DOMAIN: string
  readonly WEB_ORIGIN_PORTS: readonly number[]
  readonly isProduction: boolean
}): OriginPolicy {
  return {
    rootDomain: config.ROOT_DOMAIN,
    allowHttp: !config.isProduction,
    allowedPorts: config.WEB_ORIGIN_PORTS,
  }
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
