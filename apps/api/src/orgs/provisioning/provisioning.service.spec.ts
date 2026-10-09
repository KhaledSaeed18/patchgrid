import { Logger } from "@nestjs/common"
import { ClsServiceManager } from "nestjs-cls"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionService } from "../../auth/sessions/session.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem } from "../../common/problems/problem.exception"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import type { RequestContextStore } from "../../tenancy/request-context"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import type {
  OrganizationProvisioningRepository,
  ProvisionInput,
} from "../repositories/organization-provisioning.repository"
import type { SlugRegistryRepository } from "../repositories/slug-registry.repository"
import { DEFAULT_TEAMS, ProvisioningService } from "./provisioning.service"

const owner: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "owner@acme.test", name: "Owner", passwordHash: "h", emailVerifiedAt: new Date("2026-01-01T00:00:00Z"), anonymisedAt: null }
const unverified: AccountRecord = { ...owner, id: "0190b2f0-0000-7000-8000-000000000002", emailVerifiedAt: null }
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const context = new TenantContextService(ClsServiceManager.getClsService<RequestContextStore>())

function harness(taken: string[] = []) {
  const provisioned: (ProvisionInput & { tenantInContext: string | undefined })[] = []
  const slugs = { isTaken: vi.fn(async (slug: string) => taken.includes(slug)) }
  const repository = {
    provision: vi.fn(async (input: ProvisionInput) => {
      provisioned.push({ ...input, tenantInContext: context.current()?.orgId })
      return taken.includes(input.slug) ? { outcome: "slug-taken" as const } : { outcome: "created" as const, membershipId: "mem-1" }
    }),
  }
  const users = { findById: vi.fn(async (id: string) => [owner, unverified].find((a) => a.id === id) ?? null) }
  const lookup = { invalidate: vi.fn(async () => undefined) }
  const sessions = { open: vi.fn(async (_u: string, slug: string) => [{ name: `pg_at_${slug}`, value: "t", path: "/", maxAgeSeconds: 1 }]) }
  const service = new ProvisioningService(
    repository as unknown as OrganizationProvisioningRepository,
    slugs as unknown as SlugRegistryRepository,
    users as unknown as UserRepository,
    lookup as unknown as OrganizationLookupService,
    sessions as unknown as SessionService,
    new FixedClock(new Date("2026-10-05T12:00:00Z")),
  )
  return { service, repository, provisioned, lookup, sessions }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("ProvisioningService.availability", () => {
  it("names the reason: format, reservation, or taken", async () => {
    const { service } = harness(["acme"])
    expect(await service.availability("ab")).toEqual({ slug: "ab", available: false, reason: "too-short" })
    expect(await service.availability("API")).toEqual({ slug: "api", available: false, reason: "reserved" })
    expect(await service.availability(" Acme ")).toEqual({ slug: "acme", available: false, reason: "taken" })
    expect(await service.availability("globex")).toEqual({ slug: "globex", available: true, reason: null })
  })
})

describe("ProvisioningService.create", () => {
  it("provisions inside the new tenant's context with the owner and the default teams, then opens the session", async () => {
    const h = harness()
    const result = await h.service.create(owner.id, { name: "Acme", slug: "acme", domain: "acme.com" }, client)
    const input = h.provisioned[0]
    expect(input?.tenantInContext).toBe(input?.orgId)
    expect(input?.orgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(input).toMatchObject({ name: "Acme", slug: "acme", domain: "acme.com", owner: { userId: owner.id, displayName: "Owner" }, teams: DEFAULT_TEAMS })
    expect(h.lookup.invalidate).toHaveBeenCalledWith({ id: input?.orgId, slug: "acme" })
    expect(h.sessions.open).toHaveBeenCalledWith(owner.id, "acme", client)
    expect(result.response).toEqual({
      organization: { id: input?.orgId, name: "Acme", slug: "acme", status: "ACTIVE", plan: "FREE" },
      session: { slug: "acme" },
    })
    expect(result.cookies.map((c) => c.name)).toEqual(["pg_at_acme"])
  })

  it("is 409 when the slug is taken, and opens nothing", async () => {
    const h = harness(["acme"])
    await expect(h.service.create(owner.id, { name: "Acme", slug: "acme" }, client)).rejects.toThrow(ConflictProblem)
    expect(h.sessions.open).not.toHaveBeenCalled()
    expect(h.lookup.invalidate).not.toHaveBeenCalled()
  })

  it("requires a verified, live account", async () => {
    const h = harness()
    await expect(h.service.create(unverified.id, { name: "Acme", slug: "acme" }, client)).rejects.toThrow(NotAuthenticatedProblem)
    await expect(h.service.create("0190b2f0-0000-7000-8000-0000000000ff", { name: "Acme", slug: "acme" }, client)).rejects.toThrow(NotAuthenticatedProblem)
    expect(h.repository.provision).not.toHaveBeenCalled()
  })
})
