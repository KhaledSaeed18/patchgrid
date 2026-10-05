import { describe, expect, it } from "vitest"

import { FixedClock } from "../common/clock/clock"
import { NotFoundProblem } from "../common/problems/problem.exception"
import type { OrganizationSummary } from "../platform/repositories/organization.repository"
import type { OrganizationLookup } from "./organization-lookup"
import { TenantLookupService } from "./tenant-lookup.service"

const org = (n: number, slug: string, status: OrganizationSummary["status"] = "ACTIVE"): OrganizationSummary => ({
  id: `0190b2f0-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`,
  slug,
  status,
  plan: "FREE",
  agentVisibility: "ALL_TICKETS",
})
const acme = org(1, "acme-corp")
const frozen = org(2, "frozen", "SUSPENDED")
const leaving = org(3, "leaving", "PENDING_DELETION")
const ORGS = [acme, frozen, leaving]
const WINDOW_END = new Date("2026-11-01T00:00:00Z")

const lookup: OrganizationLookup = {
  byId: async (id) => ORGS.find((o) => o.id === id) ?? null,
  bySlug: async (slug) => ORGS.find((o) => o.slug === slug) ?? null,
  orgIdForTokenPrefix: async () => null,
  retiredSlug: async (slug, now) => {
    if (now.getTime() >= WINDOW_END.getTime()) return null
    if (slug === "acme") return { orgId: acme.id }
    if (slug === "leaving-old") return { orgId: leaving.id }
    return null
  },
}
const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
const service = new TenantLookupService(lookup, clock)

describe("TenantLookupService", () => {
  it("tells an active subdomain to render and a suspended one to show its page", async () => {
    expect(await service.lookup("acme-corp")).toEqual({ status: "active", slug: "acme-corp" })
    expect(await service.lookup("frozen")).toEqual({ status: "suspended", slug: "frozen" })
  })

  it("tells a retired slug where it moved, while the redirect window is open", async () => {
    expect(await service.lookup("acme")).toEqual({ status: "moved", slug: "acme", currentSlug: "acme-corp" })
    clock.set(WINDOW_END)
    await expect(service.lookup("acme")).rejects.toBeInstanceOf(NotFoundProblem)
    clock.set(new Date("2026-10-05T12:00:00Z"))
  })

  it.each([
    ["an unknown slug", "nobody"],
    ["a workspace pending deletion", "leaving"],
    ["a retired slug of a workspace pending deletion", "leaving-old"],
    ["a reserved label", "api"],
    ["a malformed label", "Not A Slug"],
  ])("is 404 for %s, indistinguishably", async (_label, slug) => {
    await expect(service.lookup(slug)).rejects.toBeInstanceOf(NotFoundProblem)
  })
})
