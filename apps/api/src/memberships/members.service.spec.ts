import type { MembershipStatus, Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import type { AuditEntry, AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import {
  ConflictProblem,
  NotFoundProblem,
  NotPermittedProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import type { UserOrgIndexRepository } from "../platform/repositories/user-org-index.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { PlanLimitProblem } from "../common/problems/problem.exception"
import type { QuotaService } from "../quota/quota.service"
import { MembersService } from "./members.service"
import type { MembershipRecord, MembershipRepository, MemberRow } from "./repositories/membership.repository"

const ORG = "o-1"

type Seed = { id: string; role: Role; status?: MembershipStatus; teams?: string[] }

/**
 * An in-memory organization behind the repository interface, so each rule is
 * driven through the service exactly as a request would drive it — permission,
 * then state, then the last-owner count — with the side effects observable.
 */
function harness(actorId: string, seeds: Seed[], seatsFree = true) {
  const rows = new Map<string, MembershipRecord>(
    seeds.map((s) => [
      s.id,
      {
        id: s.id,
        orgId: ORG,
        userId: `u-${s.id}`,
        role: s.role,
        status: s.status ?? "ACTIVE",
        kind: "HUMAN",
        displayName: s.id,
        teamIds: s.teams ?? [],
        leadOfTeamIds: [],
      },
    ]),
  )
  const events: string[] = []
  const audit: AuditEntry[] = []
  const seats: string[] = []
  const quota = {
    consume: vi.fn(async () => {
      if (!seatsFree) throw new PlanLimitProblem("AGENT_SEATS")
      seats.push("+1")
    }),
    release: vi.fn(async () => void seats.push("-1")),
  }

  const memberships = {
    lockOrganization: vi.fn(async () => {
      events.push("lock")
    }),
    // A copy, as a real query returns: the service must not see its own writes through it.
    findById: vi.fn(async (_org: string, id: string) => {
      const row = rows.get(id)
      return row === undefined ? null : structuredClone(row)
    }),
    countActiveOwners: vi.fn(async () => [...rows.values()].filter((r) => r.role === "OWNER" && r.status === "ACTIVE").length),
    setRole: vi.fn(async (_o: string, id: string, role: Role) => {
      const row = rows.get(id)
      if (row !== undefined) row.role = role
    }),
    setStatus: vi.fn(async (_o: string, id: string, status: MembershipStatus) => {
      const row = rows.get(id)
      if (row !== undefined) row.status = status
    }),
    leaveAllTeams: vi.fn(async (_o: string, id: string) => {
      const row = rows.get(id)
      const left = row?.teamIds ?? []
      if (row !== undefined) row.teamIds = []
      return left
    }),
    findMember: vi.fn(async (_o: string, id: string, withContact: boolean): Promise<MemberRow | null> => {
      const row = rows.get(id)
      if (row === undefined) return null
      return {
        ...row,
        avatarUrl: null,
        joinedAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        teams: row.teamIds.map((t) => ({ id: t, name: t, isLead: false })),
        contact: withContact ? { email: `${row.id}@acme.test`, lastLoginAt: null } : null,
      }
    }),
    list: vi.fn(async () => [] as MemberRow[]),
  }
  const workspaces = {
    mirror: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  }
  const epochs = {
    bump: vi.fn(async (id: string) => {
      events.push(`bump:${id}`)
    }),
  }
  const prisma = {
    transaction: vi.fn(async (fn: () => Promise<unknown>) => {
      events.push("begin")
      const result = await fn()
      events.push("commit")
      return result
    }),
  }
  const actorRow = rows.get(actorId)
  const actor: MemberActor = {
    kind: "member",
    userId: `u-${actorId}`,
    orgId: ORG,
    membershipId: actorId,
    role: actorRow?.role ?? "REQUESTER",
    teamIds: [],
    leadOfTeamIds: [],
  }

  const service = new MembersService(
    memberships as unknown as MembershipRepository,
    workspaces as unknown as UserOrgIndexRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    prisma as unknown as PrismaService,
    {
      record: vi.fn(async (_o: string, entries: AuditEntry[]) => {
        audit.push(...entries)
      }),
    } as unknown as AuditService,
    epochs as unknown as RevocationEpochService,
    quota as unknown as QuotaService,
  )
  return { service, rows, events, audit, memberships, workspaces, epochs, seats }
}

describe("MembersService.changeRole", () => {
  it("lets an owner promote an agent to admin, mirrors the picker, audits, and bumps last", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "a", role: "AGENT" }])
    const member = await h.service.changeRole("a", "ADMIN")
    expect(member.role).toBe("ADMIN")
    expect(h.workspaces.mirror).toHaveBeenCalledWith("u-a", ORG, { role: "ADMIN" })
    expect(h.audit).toEqual([
      { action: "MEMBER_ROLE_CHANGED", entityType: "Membership", entityId: "a", diff: { role: { from: "AGENT", to: "ADMIN" } } },
    ])
    expect(h.events).toEqual(["begin", "lock", "bump:a", "commit"])
  })

  it("lets an admin move members below admin, never to admin, never an admin, never themselves", async () => {
    const h = harness("admin", [
      { id: "admin", role: "ADMIN" },
      { id: "admin2", role: "ADMIN" },
      { id: "a", role: "AGENT" },
    ])
    expect((await h.service.changeRole("a", "REQUESTER")).role).toBe("REQUESTER")
    await expect(h.service.changeRole("a", "ADMIN")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(h.service.changeRole("admin2", "AGENT")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(h.service.changeRole("admin", "AGENT")).rejects.toBeInstanceOf(NotPermittedProblem)
    expect(h.rows.get("admin2")?.role).toBe("ADMIN")
  })

  it("refuses to demote the last active owner, under the lock", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "gone", role: "OWNER", status: "DISABLED" }])
    await expect(h.service.changeRole("owner", "ADMIN")).rejects.toBeInstanceOf(ConflictProblem)
    expect(h.events).toEqual(["begin", "lock"])
    expect(h.epochs.bump).not.toHaveBeenCalled()
  })

  it("lets one of two owners step down", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "owner2", role: "OWNER" }])
    expect((await h.service.changeRole("owner", "ADMIN")).role).toBe("ADMIN")
  })

  it("takes a requester out of every team", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "a", role: "AGENT", teams: ["t-1", "t-2"] }])
    await h.service.changeRole("a", "REQUESTER")
    expect(h.rows.get("a")?.teamIds).toEqual([])
    expect(h.audit[0]?.diff).toEqual({ role: { from: "AGENT", to: "REQUESTER" }, leftTeams: ["t-1", "t-2"] })
  })

  it("is a no-op for the same role: no audit, no bump", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "a", role: "AGENT" }])
    await h.service.changeRole("a", "AGENT")
    expect(h.audit).toEqual([])
    expect(h.epochs.bump).not.toHaveBeenCalled()
  })

  it("is 404 for an unknown or removed member", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "r", role: "AGENT", status: "REMOVED" }])
    await expect(h.service.changeRole("nope", "AGENT")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(h.service.changeRole("r", "REQUESTER")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

describe("MembersService.disable / enable", () => {
  it("disables an active member and revokes their sessions", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }, { id: "a", role: "AGENT" }])
    expect((await h.service.disable("a")).status).toBe("DISABLED")
    expect(h.workspaces.mirror).toHaveBeenCalledWith("u-a", ORG, { status: "DISABLED" })
    expect(h.epochs.bump).toHaveBeenCalledWith("a")
    expect(h.audit.map((e) => e.action)).toEqual(["MEMBER_DISABLED"])
  })

  it("is 403 before it is 409: an admin cannot disable an owner, whatever state they are in", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }, { id: "owner", role: "OWNER" }])
    await expect(h.service.disable("owner")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(h.service.disable("admin")).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("refuses to disable the last owner, or a member who is not active", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "d", role: "AGENT", status: "DISABLED" }])
    await expect(h.service.disable("owner")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(h.service.disable("d")).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("enables a disabled member without bumping anything", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }, { id: "d", role: "AGENT", status: "DISABLED" }])
    expect((await h.service.enable("d")).status).toBe("ACTIVE")
    expect(h.epochs.bump).not.toHaveBeenCalled()
    expect(h.audit.map((e) => e.action)).toEqual(["MEMBER_ENABLED"])
    await expect(h.service.enable("d")).rejects.toBeInstanceOf(ConflictProblem)
  })
})

describe("MembersService.remove", () => {
  it("marks the row removed, leaves every team, drops the picker row and revokes", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }, { id: "a", role: "AGENT", teams: ["t-1"] }])
    await h.service.remove("a")
    expect(h.rows.get("a")).toMatchObject({ status: "REMOVED", teamIds: [] })
    expect(h.workspaces.remove).toHaveBeenCalledWith("u-a", ORG)
    expect(h.epochs.bump).toHaveBeenCalledWith("a")
    expect(h.audit[0]).toMatchObject({ action: "MEMBER_REMOVED", diff: { status: { from: "ACTIVE", to: "REMOVED" }, leftTeams: ["t-1"] } })
  })

  it("can remove a disabled owner but never the last active one", async () => {
    const h = harness("owner", [{ id: "owner", role: "OWNER" }, { id: "old", role: "OWNER", status: "DISABLED" }])
    await h.service.remove("old")
    expect(h.rows.get("old")?.status).toBe("REMOVED")
    await expect(h.service.remove("owner")).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("is 404 the second time: a removed member is gone", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }, { id: "a", role: "AGENT" }])
    await h.service.remove("a")
    await expect(h.service.remove("a")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

describe("MembersService reads", () => {
  it("shows contact details only to agents and above", async () => {
    const asRequester = harness("r", [{ id: "r", role: "REQUESTER" }, { id: "a", role: "AGENT" }])
    expect((await asRequester.service.get("a")).contact).toBeNull()
    const asAgent = harness("a", [{ id: "a", role: "AGENT" }, { id: "b", role: "AGENT" }])
    expect((await asAgent.service.get("b")).contact).toEqual({ email: "b@acme.test", lastLoginAt: null })
  })

  it("hides removed members from everyone but admins", async () => {
    const seeds: Seed[] = [{ id: "a", role: "AGENT" }, { id: "admin", role: "ADMIN" }, { id: "r", role: "AGENT", status: "REMOVED" }]
    await expect(harness("a", seeds).service.get("r")).rejects.toBeInstanceOf(NotFoundProblem)
    expect((await harness("admin", seeds).service.get("r")).status).toBe("REMOVED")
    await expect(
      harness("a", seeds).service.list({ includeRemoved: true, limit: 25 }),
    ).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("rejects a cursor it did not issue as validation, and pages with one it did", async () => {
    const h = harness("admin", [{ id: "admin", role: "ADMIN" }])
    await expect(h.service.list({ includeRemoved: false, limit: 25, cursor: "nonsense" })).rejects.toBeInstanceOf(
      ValidationProblem,
    )
    const created = new Date("2026-10-01T00:00:00Z")
    const row = (id: string): MemberRow => ({
      id,
      userId: null,
      displayName: id,
      avatarUrl: null,
      role: "AGENT",
      status: "ACTIVE",
      kind: "HUMAN",
      joinedAt: null,
      createdAt: created,
      teams: [],
      contact: null,
    })
    h.memberships.list.mockResolvedValueOnce([row("m-1"), row("m-2"), row("m-3")])
    const page = await h.service.list({ includeRemoved: false, limit: 2 })
    expect(page.items.map((m) => m.id)).toEqual(["m-1", "m-2"])
    expect(page.nextCursor).not.toBeNull()
    await h.service.list({ includeRemoved: false, limit: 2, cursor: page.nextCursor ?? "" })
    expect(h.memberships.list).toHaveBeenLastCalledWith(ORG, expect.objectContaining({ after: { createdAt: created, id: "m-2" }, limit: 3 }))
  })
})

describe("MembersService — seats (TENANCY.md §8)", () => {
  const seeds: Seed[] = [
    { id: "owner", role: "OWNER" },
    { id: "req", role: "REQUESTER" },
    { id: "a", role: "AGENT" },
    { id: "d", role: "AGENT", status: "DISABLED" },
  ]

  it("takes a seat when a requester becomes an agent, and gives one back the other way", async () => {
    const h = harness("owner", seeds)
    await h.service.changeRole("req", "AGENT")
    await h.service.changeRole("a", "REQUESTER")
    await h.service.changeRole("owner", "OWNER")
    expect(h.seats).toEqual(["+1", "-1"])
  })

  it("frees a seat on disable and on removing an active agent, never for one already disabled", async () => {
    const h = harness("owner", seeds)
    await h.service.disable("a")
    await h.service.remove("d")
    await h.service.remove("req")
    expect(h.seats).toEqual(["-1"])
  })

  it("enabling takes a seat back, and with none free is a 402 that changes nothing", async () => {
    expect((await harness("owner", seeds).service.enable("d")).status).toBe("ACTIVE")
    const full = harness("owner", seeds, false)
    await expect(full.service.enable("d")).rejects.toBeInstanceOf(PlanLimitProblem)
    expect(full.rows.get("d")?.status).toBe("DISABLED")
    expect(full.audit).toEqual([])
  })
})
