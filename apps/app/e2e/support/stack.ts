/**
 * Where the stack under test lives. Defaults match `pnpm dev` and the CI job;
 * every address is derived from the root domain so the suite runs anywhere
 * wildcard subdomains resolve (`lvh.me` does, to 127.0.0.1).
 */
export const ROOT_DOMAIN = process.env.E2E_ROOT_DOMAIN ?? "lvh.me"
const APP_PORT = process.env.E2E_APP_PORT ?? "3001"
const API_PORT = process.env.E2E_API_PORT ?? "4000"
export const MAILPIT_URL =
  process.env.E2E_MAILPIT_URL ?? "http://localhost:8025"

export const appOrigin = `http://app.${ROOT_DOMAIN}:${APP_PORT}`
export const apiOrigin = `http://api.${ROOT_DOMAIN}:${API_PORT}`
export const apiUrl = `${apiOrigin}/api/v1`
export const workspaceOrigin = (slug: string): string =>
  `http://${slug}.${ROOT_DOMAIN}:${APP_PORT}`

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
