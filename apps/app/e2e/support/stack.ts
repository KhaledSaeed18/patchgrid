import { X509Certificate, createHash } from "node:crypto"
import dns from "node:dns"
import { readFileSync } from "node:fs"

/**
 * Where the stack under test lives. Defaults match `pnpm dev` and the CI job;
 * every address is derived from the root domain so the suite runs anywhere
 * wildcard subdomains resolve (`lvh.me` does, to 127.0.0.1).
 *
 * Behind the load balancer of the AWS rehearsal (ADR-0058) the origins are
 * https and carry no port: E2E_PROTOCOL=https, E2E_APP_PORT= and E2E_API_PORT=.
 */
export const ROOT_DOMAIN = process.env.E2E_ROOT_DOMAIN ?? "lvh.me"
const PROTOCOL = process.env.E2E_PROTOCOL ?? "http"
const APP_PORT = process.env.E2E_APP_PORT ?? "3001"
const API_PORT = process.env.E2E_API_PORT ?? "4000"
export const MAILPIT_URL =
  process.env.E2E_MAILPIT_URL ?? "http://localhost:8025"

const port = (value: string): string => (value === "" ? "" : `:${value}`)
const origin = (host: string, at: string): string =>
  `${PROTOCOL}://${host}${port(at)}`

export const appOrigin = origin(`app.${ROOT_DOMAIN}`, APP_PORT)
export const apiOrigin = origin(`api.${ROOT_DOMAIN}`, API_PORT)
export const apiUrl = `${apiOrigin}/api/v1`
export const workspaceOrigin = (slug: string): string =>
  origin(`${slug}.${ROOT_DOMAIN}`, APP_PORT)

/**
 * Chromium's flags for a stack that is not on lvh.me. E2E_RESOLVE_TO sends the
 * root domain and every subdomain to one address, the load balancer's.
 * E2E_CA_FILE trusts the private CA that signed its certificate, by the hash of
 * its public key, so the certificate verifies with no change to the machine's
 * trust store; a page with a certificate error would get no WebAuthn.
 */
function chromiumFlags(): string[] {
  const flags: string[] = []
  const resolveTo = process.env.E2E_RESOLVE_TO ?? ""
  if (resolveTo !== "") {
    flags.push(
      `--host-resolver-rules=MAP ${ROOT_DOMAIN} ${resolveTo}, MAP *.${ROOT_DOMAIN} ${resolveTo}`
    )
  }
  const caFile = process.env.E2E_CA_FILE ?? ""
  if (caFile !== "") {
    const spki = new X509Certificate(readFileSync(caFile)).publicKey.export({
      type: "spki",
      format: "der",
    })
    flags.push(
      `--ignore-certificate-errors-spki-list=${createHash("sha256").update(spki).digest("base64")}`
    )
  }
  return flags
}
export const chromiumArgs = chromiumFlags()

/**
 * The same rule for this process, where the `request` fixture resolves names
 * through Node rather than Chromium: the root domain and every subdomain answer
 * E2E_RESOLVE_TO, and every other name resolves as before. No change to the
 * machine's own resolver, as with the CA above.
 */
function resolveRootDomain(): void {
  const address = process.env.E2E_RESOLVE_TO ?? ""
  if (address === "") return
  const original = dns.lookup
  const ours = (hostname: string): boolean =>
    hostname === ROOT_DOMAIN || hostname.endsWith(`.${ROOT_DOMAIN}`)
  const lookup = (hostname: string, ...rest: unknown[]): void => {
    const callback = rest.at(-1)
    if (!ours(hostname) || typeof callback !== "function") {
      Reflect.apply(original, dns, [hostname, ...rest])
      return
    }
    const options = rest.length > 1 ? rest[0] : undefined
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      options.all === true
    if (all) callback(null, [{ address, family: 4 }])
    else callback(null, address, 4)
  }
  dns.lookup = lookup as typeof dns.lookup

  // Playwright's own requests resolve per family through the promise API.
  const promised = dns.promises.lookup
  const lookupPromise = async (
    hostname: string,
    options?: unknown
  ): Promise<unknown> => {
    if (!ours(hostname))
      return Reflect.apply(promised, dns.promises, [hostname, options])
    const family =
      typeof options === "object" && options !== null && "family" in options
        ? options.family
        : 0
    const v4 = family === 0 || family === 4 || family === "IPv4"
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      options.all === true
    if (all) return v4 ? [{ address, family: 4 }] : []
    if (!v4)
      throw Object.assign(new Error(`ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND",
      })
    return { address, family: 4 }
  }
  dns.promises.lookup = lookupPromise as typeof dns.promises.lookup
}
resolveRootDomain()

/** The seeded people (`pnpm db:seed`): one password for all, memberships as `packages/database/src/lookalikes.ts` lists them. */
export const SEED_PASSWORD = "patchgrid-demo"
export const people = {
  alice: { email: "alice@patchgrid.test", name: "Alice Owner" }, // Acme OWNER
  dana: { email: "dana@patchgrid.test", name: "Dana Dual" }, // Acme ADMIN, Globex AGENT
  sam: { email: "sam@patchgrid.test", name: "Sam Agent" }, // Acme AGENT, team Network
  rita: { email: "rita@patchgrid.test", name: "Rita Requester" }, // Acme REQUESTER
  gus: { email: "gus@patchgrid.test", name: "Gus Owner" }, // Globex OWNER
} as const

export const ACME = "acme"
export const GLOBEX = "globex"

/** A unique suffix per run, so a re-run never trips over its own rows. */
export const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A literal origin inside a `RegExp`: every metacharacter escaped, not just the dots. */
export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
