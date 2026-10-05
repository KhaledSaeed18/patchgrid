import { describe, expect, it } from "vitest"

import type { OrganizationSummary } from "../platform/repositories/organization.repository"
import type { Assertion, Credential, Located } from "./credential-locator"
import type { OrganizationLookup } from "./organization-lookup"
import { TenantResolver } from "./tenant-resolver"

const org = (n: number, slug: string, status: OrganizationSummary["status"] = "ACTIVE"): OrganizationSummary => ({
  id: `0190b2f0-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`,
  slug,
  status,
  plan: "FREE",
  agentVisibility: "ALL_TICKETS",
})
const acme = org(1, "acme")
const globex = org(2, "globex")
const frozen = org(3, "frozen", "SUSPENDED")
const leaving = org(4, "leaving", "PENDING_DELETION")
const ORGS = [acme, globex, frozen, leaving]

const lookup: OrganizationLookup = {
  byId: async (id) => ORGS.find((o) => o.id === id) ?? null,
  bySlug: async (slug) => ORGS.find((o) => o.slug === slug) ?? null,
  orgIdForTokenPrefix: async (prefix) => (prefix === "acmetok" ? acme.id : null),
  retiredSlug: async () => null,
}
const resolver = new TenantResolver(lookup)

const fromTenant = (slug: string): Assertion => ({ origin: { kind: "tenant", slug }, header: null })
const fromHeader = (slug: string): Assertion => ({ origin: { kind: "absent" }, header: slug })
const fromApp: Assertion = { origin: { kind: "infrastructure", label: "app" }, header: null }
const fromNowhere: Assertion = { origin: { kind: "absent" }, header: null }
const fromElsewhere: Assertion = { origin: { kind: "foreign" }, header: null }

const cookie = (o: OrganizationSummary, slug = o.slug): Credential => ({ kind: "cookie", slug, orgId: o.id })
const bearer = (prefix: string | null): Credential => ({ kind: "bearer", prefix })
const none: Credential = { kind: "none" }

const resolve = (credential: Credential, assertion: Assertion) =>
  resolver.resolve({ credential, assertion } satisfies Located)

const refusal = (problem: string) => expect.objectContaining({ ok: false, refusal: expect.objectContaining({ problem }) })

describe("TenantResolver — cookie sessions", () => {
  it("admits a cookie whose claim matches the Origin's slug", async () => {
    const result = await resolve(cookie(acme), fromTenant("acme"))
    expect(result).toEqual({ ok: true, tenant: { ...acme, via: "cookie" } })
  })

  it("admits the same cookie asserted through X-Patchgrid-Tenant server-side", async () => {
    expect(await resolve(cookie(acme), fromHeader("acme"))).toMatchObject({ ok: true })
  })

  it("refuses a cookie whose claim names another workspace than its name", async () => {
    // A tossed or forged pg_at_acme carrying globex's org id.
    expect(await resolve(cookie(globex, "acme"), fromTenant("acme"))).toEqual(refusal("tenant-mismatch"))
  })

  it("refuses when Origin and X-Patchgrid-Tenant disagree", async () => {
    const assertion: Assertion = { origin: { kind: "tenant", slug: "acme" }, header: "globex" }
    expect(await resolve(cookie(acme), assertion)).toEqual(refusal("tenant-mismatch"))
  })

  it("is 401 for an unreadable or orphaned claim", async () => {
    expect(await resolve({ kind: "cookie", slug: "acme", orgId: null }, fromTenant("acme"))).toEqual(
      refusal("not-authenticated"),
    )
    expect(
      await resolve({ kind: "cookie", slug: "acme", orgId: "0190b2f0-0000-7000-8000-0000000000ff" }, fromTenant("acme")),
    ).toEqual(refusal("not-authenticated"))
  })
})

describe("TenantResolver — no credential", () => {
  it("is 404 for an unknown workspace and 401 for a known one", async () => {
    expect(await resolve(none, fromTenant("nobody"))).toEqual(refusal("not-found"))
    expect(await resolve(none, fromTenant("acme"))).toEqual(refusal("not-authenticated"))
  })

  it("reports the workspace's state before asking for a session", async () => {
    expect(await resolve(none, fromTenant("frozen"))).toEqual(refusal("organization-suspended"))
    expect(await resolve(none, fromTenant("leaving"))).toEqual(refusal("not-found"))
  })

  it("is 403 when nothing names a workspace at all", async () => {
    expect(await resolve(none, fromNowhere)).toEqual(refusal("tenant-mismatch"))
    expect(await resolve(none, fromApp)).toEqual(refusal("tenant-mismatch"))
  })
})

describe("TenantResolver — bearer tokens", () => {
  it("admits a known prefix, from any of our origins or none", async () => {
    expect(await resolve(bearer("acmetok"), fromTenant("acme"))).toEqual({ ok: true, tenant: { ...acme, via: "bearer" } })
    expect(await resolve(bearer("acmetok"), fromNowhere)).toMatchObject({ ok: true })
    expect(await resolve(bearer("acmetok"), fromApp)).toMatchObject({ ok: true })
  })

  it("is 403 when the token is used against another workspace", async () => {
    expect(await resolve(bearer("acmetok"), fromTenant("globex"))).toEqual(refusal("tenant-mismatch"))
    expect(await resolve(bearer("acmetok"), fromHeader("globex"))).toEqual(refusal("tenant-mismatch"))
  })

  it("is 401 for a malformed, unknown or revoked token", async () => {
    expect(await resolve(bearer(null), fromTenant("acme"))).toEqual(refusal("not-authenticated"))
    expect(await resolve(bearer("nope"), fromTenant("acme"))).toEqual(refusal("not-authenticated"))
  })
})

describe("TenantResolver — organization state", () => {
  it("never admits a suspended or deleting workspace, however good the credential", async () => {
    expect(await resolve(cookie(frozen), fromTenant("frozen"))).toEqual(refusal("organization-suspended"))
    expect(await resolve(cookie(leaving), fromTenant("leaving"))).toEqual(refusal("not-found"))
  })

  it("refuses a foreign Origin before looking anything up", async () => {
    expect(await resolve(cookie(acme), fromElsewhere)).toEqual(refusal("tenant-mismatch"))
    expect(await resolve(bearer("acmetok"), fromElsewhere)).toEqual(refusal("tenant-mismatch"))
  })
})
