import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ApiTokenIndexRepository } from "../platform/repositories/api-token-index.repository"
import type {
  OrganizationRepository,
  OrganizationSummary,
} from "../platform/repositories/organization.repository"
import type { RedisService } from "../redis/redis.service"
import { OrganizationLookupService } from "./organization-lookup.service"

const acme: OrganizationSummary = {
  id: "0190b2f0-0000-7000-8000-00000000000a",
  slug: "acme",
  status: "ACTIVE",
  plan: "FREE",
  agentVisibility: "ALL_TICKETS",
}

/** An in-memory Redis that can be switched off to simulate an outage. */
function fakeRedis() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  let down = false
  const fail = () => Promise.reject(new Error("ECONNREFUSED"))
  const client = {
    get: vi.fn((key: string) => (down ? fail() : Promise.resolve(store.get(key) ?? null))),
    set: vi.fn((key: string, value: string, _ex: string, ttl: number) => {
      if (down) return fail()
      store.set(key, value)
      ttls.set(key, ttl)
      return Promise.resolve("OK")
    }),
    del: vi.fn((...keys: string[]) => {
      if (down) return fail()
      for (const key of keys) store.delete(key)
      return Promise.resolve(keys.length)
    }),
  }
  return {
    service: { client } as unknown as RedisService,
    store,
    ttls,
    client,
    outage(on: boolean) {
      down = on
    },
  }
}

function fakeRepositories(orgs: OrganizationSummary[]) {
  const organizations = {
    findSummaryById: vi.fn(async (id: string) => orgs.find((o) => o.id === id) ?? null),
    findSummaryBySlug: vi.fn(async (slug: string) => orgs.find((o) => o.slug === slug) ?? null),
    findRetiredSlug: vi.fn(async (slug: string) =>
      slug === "acme-old" ? { orgId: acme.id, redirectUntil: new Date("2026-11-01T00:00:00Z") } : null,
    ),
  }
  const tokens = {
    findByPrefix: vi.fn(async (prefix: string) =>
      prefix === "live"
        ? { orgId: acme.id, revokedAt: null }
        : prefix === "dead"
          ? { orgId: acme.id, revokedAt: new Date() }
          : null,
    ),
  }
  return {
    organizations: organizations as unknown as OrganizationRepository,
    tokens: tokens as unknown as ApiTokenIndexRepository,
    calls: { organizations, tokens },
  }
}

let redis: ReturnType<typeof fakeRedis>
let repos: ReturnType<typeof fakeRepositories>
let lookup: OrganizationLookupService

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  redis = fakeRedis()
  repos = fakeRepositories([acme])
  lookup = new OrganizationLookupService(redis.service, repos.organizations, repos.tokens)
})

describe("OrganizationLookupService", () => {
  it("reads through once, then serves from the cache with a 60 s TTL", async () => {
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(repos.calls.organizations.findSummaryById).toHaveBeenCalledTimes(1)
    expect(redis.ttls.get(`tenant:org:${acme.id}`)).toBe(60)
  })

  it("caches a miss briefly rather than hitting the database per request", async () => {
    expect(await lookup.bySlug("nobody")).toBeNull()
    expect(await lookup.bySlug("nobody")).toBeNull()
    expect(repos.calls.organizations.findSummaryBySlug).toHaveBeenCalledTimes(1)
    expect(redis.ttls.get("tenant:slug:nobody")).toBe(10)
  })

  it("resolves a slug through its id, priming the summary on the way", async () => {
    expect(await lookup.bySlug("acme")).toEqual(acme)
    expect(repos.calls.organizations.findSummaryBySlug).toHaveBeenCalledTimes(1)
    // The summary was stored by the slug read; the id read needs no database.
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(repos.calls.organizations.findSummaryById).not.toHaveBeenCalled()
  })

  it("does not serve an org under a slug it no longer has", async () => {
    await lookup.bySlug("acme")
    // The slug changed and the summary slot was refreshed, but the slug
    // pointer survived (whoever renamed forgot to invalidate).
    redis.store.set(`tenant:org:${acme.id}`, JSON.stringify({ ...acme, slug: "acme-corp" }))
    expect(await lookup.bySlug("acme")).toBeNull()
  })

  it("falls through to the database when Redis is down, and keeps answering", async () => {
    redis.outage(true)
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(repos.calls.organizations.findSummaryById).toHaveBeenCalledTimes(2)
  })

  it("drops a cache entry it no longer understands", async () => {
    redis.store.set(`tenant:org:${acme.id}`, JSON.stringify({ id: acme.id, legacy: true }))
    expect(await lookup.byId(acme.id)).toEqual(acme)
    expect(repos.calls.organizations.findSummaryById).toHaveBeenCalledTimes(1)
  })

  it("treats a revoked token prefix exactly like an unknown one", async () => {
    expect(await lookup.orgIdForTokenPrefix("live")).toBe(acme.id)
    expect(await lookup.orgIdForTokenPrefix("dead")).toBeNull()
    expect(await lookup.orgIdForTokenPrefix("none")).toBeNull()
  })

  it("answers a retired slug only inside its redirect window", async () => {
    expect(await lookup.retiredSlug("acme-old", new Date("2026-10-05T00:00:00Z"))).toEqual({ orgId: acme.id })
    expect(await lookup.retiredSlug("acme-old", new Date("2026-11-01T00:00:00Z"))).toBeNull()
    expect(await lookup.retiredSlug("never", new Date())).toBeNull()
  })

  it("invalidates the summary and both slug pointers on a rename", async () => {
    await lookup.bySlug("acme")
    await lookup.invalidate({ id: acme.id, slug: "acme-corp", previousSlug: "acme" })
    expect(redis.client.del).toHaveBeenCalledWith(
      `tenant:org:${acme.id}`,
      "tenant:slug:acme-corp",
      "tenant:slug:acme",
    )
    expect(redis.store.size).toBe(0)
  })
})
