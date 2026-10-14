import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { AuditEntry, AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import type { MembershipRepository } from "../memberships/repositories/membership.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { AssetsService } from "./assets.service"
import type { AssetFields, AssetListFilter, AssetRepository, AssetRow } from "./repositories/asset.repository"

const ORG = "o-1"

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "a-1",
    name: "ThinkPad T14",
    type: "LAPTOP",
    status: "IN_USE",
    serialNumber: "SN-1",
    ownerMembershipId: "m-rita",
    purchaseDate: new Date("2025-01-10T00:00:00Z"),
    warrantyExpiresAt: new Date("2028-01-10T00:00:00Z"),
    notes: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    owner: { id: "m-rita", displayName: "Rita" },
    ...over,
  }
}

/** An in-memory register behind the repository, so each rule runs through the service. */
function harness(role: Role, membershipId: string, rows: AssetRow[] = [asset()], tickets: Record<string, number> = {}) {
  const store = new Map(rows.map((r) => [r.id, r]))
  const audit: AuditEntry[] = []
  const listed: { branch: unknown; filter: AssetListFilter }[] = []
  const repo = {
    find: async (_o: string, id: string) => store.get(id) ?? null,
    findMany: async (_o: string, ids: string[]) => ids.flatMap((id) => store.get(id) ?? []),
    list: async (_o: string, branch: unknown, filter: AssetListFilter) => {
      listed.push({ branch, filter })
      return [...store.values()]
    },
    lock: vi.fn(async () => undefined),
    ticketCount: async (_o: string, id: string) => tickets[id] ?? 0,
    create: async (_o: string, fields: AssetFields) => {
      if ([...store.values()].some((r) => fields.serialNumber !== null && r.serialNumber === fields.serialNumber)) return "serial-taken" as const
      store.set("a-new", asset({ ...fields, id: "a-new", owner: null }))
      return "a-new"
    },
    update: async (_o: string, id: string, fields: Partial<AssetFields>) => {
      const before = store.get(id)
      if (before !== undefined) store.set(id, { ...before, ...fields })
      return "ok" as const
    },
    remove: async (_o: string, id: string) => store.delete(id),
  }
  const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId, role, teamIds: [], leadOfTeamIds: [] }
  const service = new AssetsService(
    repo as unknown as AssetRepository,
    { findById: async (_o: string, id: string) => (id === "m-gone" ? { id, status: "REMOVED" } : id === "m-ghost" ? null : { id, status: "ACTIVE" }) } as unknown as MembershipRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG, organization: () => ({ agentVisibility: "OWN_TEAM_ONLY" }) } as unknown as TenantContextService,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, entries: AuditEntry[]) => void audit.push(...entries) } as unknown as AuditService,
  )
  return { service, store, audit, listed, repo, actor }
}

describe("AssetsService reads", () => {
  it("lists a requester's own assets and everyone's for an agent", async () => {
    const requester = harness("REQUESTER", "m-rita")
    await requester.service.list({ limit: 25 })
    expect(requester.listed[0]?.branch).toEqual({ kind: "owner", membershipId: "m-rita" })

    const agent = harness("AGENT", "m-sam")
    await agent.service.list({ limit: 25, q: "think" })
    expect(agent.listed[0]?.branch).toBeNull()
    expect(agent.listed[0]?.filter).toMatchObject({ q: "think", limit: 26 })
  })

  it("is 404 for an asset a requester does not hold, and shows them theirs without edit rights", async () => {
    await expect(harness("REQUESTER", "m-rosa").service.get("a-1")).rejects.toBeInstanceOf(NotFoundProblem)
    const own = await harness("REQUESTER", "m-rita").service.get("a-1")
    // Rita may open her laptop, not every ticket about it: no count.
    expect(own).toMatchObject({ purchaseDate: "2025-01-10", ticketCount: null, capabilities: { canEdit: false, canDelete: false } })
    expect((await harness("AGENT", "m-sam", [asset()], { "a-1": 3 }).service.get("a-1")).ticketCount).toBeNull()
    expect((await harness("ADMIN", "m-alice", [asset()], { "a-1": 3 }).service.get("a-1")).ticketCount).toBe(3)
    expect((await harness("ADMIN", "m-alice").service.get("a-1")).capabilities).toEqual({ canEdit: true, canDelete: true })
  })

  it("names to a ticket only the assets the actor can open", async () => {
    const h = harness("REQUESTER", "m-rita", [asset(), asset({ id: "a-2", ownerMembershipId: "m-rosa" })])
    expect((await h.service.visible(ORG, h.actor, ["a-1", "a-2"])).map((a) => a.id)).toEqual(["a-1"])
  })
})

describe("AssetsService writes", () => {
  it("refuses a requester, a taken serial, a removed owner and a warranty before the purchase", async () => {
    await expect(harness("REQUESTER", "m-rita").service.create({ name: "x", type: "LAPTOP" })).rejects.toBeInstanceOf(NotPermittedProblem)
    const agent = harness("AGENT", "m-sam")
    await expect(agent.service.create({ name: "x", type: "LAPTOP", serialNumber: "SN-1" })).rejects.toBeInstanceOf(ConflictProblem)
    await expect(agent.service.create({ name: "x", type: "LAPTOP", ownerMembershipId: "m-gone" })).rejects.toBeInstanceOf(ValidationProblem)
    await expect(
      agent.service.create({ name: "x", type: "LAPTOP", purchaseDate: "2025-02-01", warrantyExpiresAt: "2025-01-01" }),
    ).rejects.toBeInstanceOf(ValidationProblem)
    // The stored purchase date counts against an edit that moves only the warranty.
    await expect(agent.service.update("a-1", { warrantyExpiresAt: "2024-12-31" })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("audits only the fields that changed, dates as days", async () => {
    const h = harness("AGENT", "m-sam")
    await h.service.update("a-1", { status: "IN_REPAIR", purchaseDate: "2025-01-10", warrantyExpiresAt: "2029-01-10" })
    expect(h.audit).toEqual([
      {
        action: "ASSET_UPDATED",
        entityType: "Asset",
        entityId: "a-1",
        diff: { status: { from: "IN_USE", to: "IN_REPAIR" }, warrantyExpiresAt: { from: "2028-01-10", to: "2029-01-10" } },
      },
    ])
    await h.service.update("a-1", { status: "IN_REPAIR" })
    expect(h.audit).toHaveLength(1)
  })

  it("deletes only for an admin, and never an asset a ticket names", async () => {
    await expect(harness("AGENT", "m-sam").service.remove("a-1")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness("ADMIN", "m-alice", [asset()], { "a-1": 2 }).service.remove("a-1")).rejects.toBeInstanceOf(ConflictProblem)
    const h = harness("ADMIN", "m-alice")
    await h.service.remove("a-1")
    expect(h.store.has("a-1")).toBe(false)
    expect(h.repo.lock).toHaveBeenCalled()
    expect(h.audit[0]?.action).toBe("ASSET_DELETED")
  })
})
