import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../../auth/actor"
import type { CookieService } from "../../auth/cookies"
import type { SessionService } from "../../auth/sessions/session.service"
import type { AuditEntry, AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotPermittedProblem } from "../../common/problems/problem.exception"
import type { PrismaService } from "../../prisma/prisma.service"
import type { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type {
  OrganizationSettingsRecord,
  OrganizationSettingsRepository,
} from "../repositories/organization-settings.repository"
import type { SlugRegistryRepository } from "../repositories/slug-registry.repository"
import { OrgSettingsService } from "./org-settings.service"

const NOW = new Date("2026-10-09T12:00:00Z")
const DAY = 86_400_000
const client = { userAgent: "vitest", ip: "127.0.0.1" }

function harness(role: Role, options: { lastRelease?: Date; taken?: string[] } = {}) {
  const org: OrganizationSettingsRecord = {
    id: "o-1",
    name: "Acme",
    slug: "acme",
    status: "ACTIVE",
    plan: "FREE",
    domain: null,
    agentVisibility: "ALL_TICKETS",
    emailNotificationsEnabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }
  const audit: AuditEntry[] = []
  const repo = {
    find: vi.fn(async () => ({ ...org })),
    update: vi.fn(async (_o: string, data: Partial<OrganizationSettingsRecord>) => void Object.assign(org, data)),
    lastSlugRelease: vi.fn(async () => options.lastRelease ?? null),
    retireSlug: vi.fn(async () => undefined),
    setSlug: vi.fn(async (_o: string, slug: string) => void (org.slug = slug)),
    mirrorToPicker: vi.fn(async () => undefined),
  }
  const slugs = { lock: vi.fn(async () => undefined), isTaken: vi.fn(async (s: string) => (options.taken ?? []).includes(s)) }
  const lookup = { invalidate: vi.fn(async () => undefined) }
  const sessions = { open: vi.fn(async (_u: string, slug: string) => [{ name: `pg_at_${slug}`, value: "t", path: "/", maxAgeSeconds: 1 }]) }
  const actor: MemberActor = { kind: "member", userId: "u-1", orgId: "o-1", membershipId: "m-1", role, teamIds: [], leadOfTeamIds: [] }
  const service = new OrgSettingsService(
    repo as unknown as OrganizationSettingsRepository,
    slugs as unknown as SlugRegistryRepository,
    new PermissionService(),
    { requireTenantActor: () => actor, requireMember: () => actor } as unknown as ActorService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, e: AuditEntry[]) => void audit.push(...e) } as unknown as AuditService,
    lookup as unknown as OrganizationLookupService,
    sessions as unknown as SessionService,
    { pairOf: (slug: string) => [{ name: `pg_at_${slug}`, path: "/" }, { name: `pg_rt_${slug}`, path: "/api/v1/auth" }] } as unknown as CookieService,
    new FixedClock(NOW),
  )
  return { service, repo, slugs, lookup, sessions, audit }
}

describe("OrgSettingsService.get", () => {
  it("is for agents and above, and says when the slug may next change", async () => {
    await expect(harness("REQUESTER").service.get()).rejects.toBeInstanceOf(NotPermittedProblem)
    expect((await harness("AGENT").service.get()).slugChangeAvailableAt).toBeNull()
    const cooling = harness("AGENT", { lastRelease: new Date(NOW.getTime() - 10 * DAY) })
    expect((await cooling.service.get()).slugChangeAvailableAt).toBe("2026-10-29T12:00:00.000Z")
  })
})

describe("OrgSettingsService.update", () => {
  it("is an admin's; agents read but do not write", async () => {
    await expect(harness("AGENT").service.update({ name: "X" })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("renames, mirrors the picker, audits the diff — and leaves the cached summary alone", async () => {
    const h = harness("ADMIN")
    expect((await h.service.update({ name: "Acme Corp" })).name).toBe("Acme Corp")
    expect(h.repo.mirrorToPicker).toHaveBeenCalledWith("o-1", { orgName: "Acme Corp" })
    expect(h.audit).toEqual([{ action: "ORG_SETTINGS_UPDATED", entityType: "Organization", entityId: "o-1", diff: { name: { from: "Acme", to: "Acme Corp" } } }])
    expect(h.lookup.invalidate).not.toHaveBeenCalled()
  })

  it("gives agent visibility its own audit action and invalidates the cached summary", async () => {
    const h = harness("ADMIN")
    await h.service.update({ agentVisibility: "OWN_TEAM_ONLY" })
    expect(h.audit.map((e) => e.action)).toEqual(["AGENT_VISIBILITY_CHANGED"])
    expect(h.lookup.invalidate).toHaveBeenCalledWith({ id: "o-1", slug: "acme" })
  })

  it("records nothing when nothing changed", async () => {
    const h = harness("ADMIN")
    await h.service.update({ name: "Acme", agentVisibility: "ALL_TICKETS" })
    expect(h.audit).toEqual([])
    expect(h.repo.mirrorToPicker).not.toHaveBeenCalled()
  })
})

describe("OrgSettingsService.changeSlug", () => {
  it("is the owner's alone", async () => {
    await expect(harness("ADMIN").service.changeSlug("acme-corp", client)).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("retires the old slug for a 30-day redirect, mirrors, audits, invalidates both pointers and moves the session", async () => {
    const h = harness("OWNER")
    const result = await h.service.changeSlug("acme-corp", client)
    expect(h.slugs.lock).toHaveBeenCalledWith("acme", "acme-corp")
    expect(h.repo.retireSlug).toHaveBeenCalledWith("o-1", "acme", NOW, new Date(NOW.getTime() + 30 * DAY))
    expect(h.repo.mirrorToPicker).toHaveBeenCalledWith("o-1", { orgSlug: "acme-corp" })
    expect(h.audit).toEqual([{ action: "ORG_SLUG_CHANGED", entityType: "Organization", entityId: "o-1", diff: { slug: { from: "acme", to: "acme-corp" } } }])
    expect(h.lookup.invalidate).toHaveBeenCalledWith({ id: "o-1", slug: "acme-corp", previousSlug: "acme" })
    expect(result.response).toEqual({ slug: "acme-corp", previousSlug: "acme", redirectUntil: "2026-11-08T12:00:00.000Z", session: { slug: "acme-corp" } })
    expect(result.set.map((c) => c.name)).toEqual(["pg_at_acme-corp"])
    expect(result.clear.map((c) => c.name)).toEqual(["pg_at_acme", "pg_rt_acme"])
  })

  it("refuses the current slug, a taken or retired one, and a change inside the cooldown", async () => {
    await expect(harness("OWNER").service.changeSlug("acme", client)).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness("OWNER", { taken: ["globex"] }).service.changeSlug("globex", client)).rejects.toBeInstanceOf(ConflictProblem)
    const cooling = harness("OWNER", { lastRelease: new Date(NOW.getTime() - 29 * DAY) })
    await expect(cooling.service.changeSlug("acme-corp", client)).rejects.toThrow("can change again on 2026-10-10")
    const cooled = harness("OWNER", { lastRelease: new Date(NOW.getTime() - 30 * DAY) })
    await expect(cooled.service.changeSlug("acme-corp", client)).resolves.toBeDefined()
  })
})
