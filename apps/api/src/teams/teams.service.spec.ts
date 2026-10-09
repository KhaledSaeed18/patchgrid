import type { MembershipStatus, Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import type { AuditEntry, AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem } from "../common/problems/problem.exception"
import type { MembershipRecord, MembershipRepository } from "../memberships/repositories/membership.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { TeamRepository, TeamRow } from "./repositories/team.repository"
import { TeamsService } from "./teams.service"

const ORG = "o-1"

type World = {
  actor: { id: string; role: Role; leads?: string[] }
  members: { id: string; role: Role; status?: MembershipStatus }[]
  teams: { id: string; name: string; isActive?: boolean; members?: string[]; lead?: string }[]
}

/** An in-memory organization behind the repositories, so each rule runs through the service. */
function harness(world: World) {
  const teams = new Map(
    world.teams.map((t) => [
      t.id,
      { id: t.id, name: t.name, description: null as string | null, isActive: t.isActive ?? true, members: new Map((t.members ?? []).map((m) => [m, m === t.lead])) },
    ]),
  )
  const audit: AuditEntry[] = []
  const bumps: string[] = []
  const row = (id: string): TeamRow | null => {
    const t = teams.get(id)
    if (t === undefined) return null
    const lead = [...t.members].find(([, isLead]) => isLead)?.[0]
    return { id: t.id, name: t.name, description: t.description, isActive: t.isActive, memberCount: t.members.size, lead: lead === undefined ? null : { membershipId: lead, displayName: lead } }
  }
  const repo = {
    findById: async (_o: string, id: string) => {
      const t = teams.get(id)
      return t === undefined ? null : { id: t.id, orgId: ORG, name: t.name, isActive: t.isActive }
    },
    findRow: async (_o: string, id: string) => row(id),
    list: async () => [...teams.keys()].map((id) => row(id)).filter((r) => r !== null),
    members: async (_o: string, id: string) =>
      [...(teams.get(id)?.members ?? [])].map(([m, isLead]) => ({ membershipId: m, displayName: m, role: "AGENT" as Role, isLead, joinedAt: new Date(0) })),
    lock: async () => undefined,
    create: async (_o: string, data: { name: string }) => {
      if ([...teams.values()].some((t) => t.name === data.name)) return "name-taken" as const
      teams.set("t-new", { id: "t-new", name: data.name, description: null, isActive: true, members: new Map() })
      return "t-new"
    },
    update: async (_o: string, id: string, data: { name?: string; isActive?: boolean }) => {
      const t = teams.get(id)
      if (t === undefined) return
      if (data.name !== undefined && [...teams.values()].some((o) => o.id !== id && o.name === data.name)) return "name-taken" as const
      Object.assign(t, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)))
    },
    findMembership: async (_o: string, teamId: string, m: string) => {
      const isLead = teams.get(teamId)?.members.get(m)
      return isLead === undefined ? null : { isLead }
    },
    addMember: async (_o: string, teamId: string, m: string) => void teams.get(teamId)?.members.set(m, false),
    removeMember: async (_o: string, teamId: string, m: string) => void teams.get(teamId)?.members.delete(m),
    clearLead: async (_o: string, teamId: string) => {
      const t = teams.get(teamId)
      const lead = [...(t?.members ?? [])].find(([, isLead]) => isLead)?.[0] ?? null
      if (lead !== null) t?.members.set(lead, false)
      return lead
    },
    makeLead: async (_o: string, teamId: string, m: string) => void teams.get(teamId)?.members.set(m, true),
  }
  const memberships = {
    findById: async (_o: string, id: string): Promise<MembershipRecord | null> => {
      const m = world.members.find((x) => x.id === id)
      return m === undefined ? null : { id: m.id, orgId: ORG, userId: `u-${m.id}`, role: m.role, status: m.status ?? "ACTIVE", kind: "HUMAN", displayName: m.id, teamIds: [], leadOfTeamIds: [] }
    },
  }
  const actor: MemberActor = {
    kind: "member",
    userId: "u",
    orgId: ORG,
    membershipId: world.actor.id,
    role: world.actor.role,
    teamIds: world.actor.leads ?? [],
    leadOfTeamIds: world.actor.leads ?? [],
  }
  const service = new TeamsService(
    repo as unknown as TeamRepository,
    memberships as unknown as MembershipRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, e: AuditEntry[]) => void audit.push(...e) } as unknown as AuditService,
    { bump: vi.fn(async (id: string) => void bumps.push(id)) } as unknown as RevocationEpochService,
  )
  return { service, teams, audit, bumps }
}

const base: Omit<World, "actor"> = {
  members: [
    { id: "lead", role: "AGENT" },
    { id: "agent", role: "AGENT" },
    { id: "req", role: "REQUESTER" },
    { id: "off", role: "AGENT", status: "DISABLED" },
  ],
  teams: [
    { id: "net", name: "Network", members: ["lead"], lead: "lead" },
    { id: "sec", name: "Security" },
    { id: "old", name: "Old", isActive: false },
  ],
}

describe("TeamsService — who may change a team's members", () => {
  it("a lead manages their own team, and only their own", async () => {
    const h = harness({ ...base, actor: { id: "lead", role: "AGENT", leads: ["net"] } })
    await h.service.addMember("net", "agent")
    expect(h.teams.get("net")?.members.has("agent")).toBe(true)
    expect(h.bumps).toEqual(["agent"])
    expect(h.audit).toEqual([{ action: "TEAM_MEMBER_ADDED", entityType: "Team", entityId: "net", diff: { membershipId: "agent" } }])
    await expect(h.service.addMember("sec", "agent")).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("an agent who leads nothing manages nothing; an admin manages any team", async () => {
    await expect(harness({ ...base, actor: { id: "agent", role: "AGENT" } }).service.addMember("net", "agent")).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(harness({ ...base, actor: { id: "a", role: "ADMIN" } }).service.addMember("sec", "agent")).resolves.toBeUndefined()
  })

  it("refuses requesters, inactive members, unknown members and deactivated teams", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await expect(h.service.addMember("net", "req")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(h.service.addMember("net", "off")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(h.service.addMember("net", "ghost")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(h.service.addMember("old", "agent")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(h.service.addMember("nope", "agent")).rejects.toBeInstanceOf(NotFoundProblem)
  })

  it("adding someone already in the team changes nothing — no audit, no bump", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await h.service.addMember("net", "lead")
    expect(h.audit).toEqual([])
    expect(h.bumps).toEqual([])
  })

  it("removing the lead clears the lead, and says so", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await h.service.removeMember("net", "lead")
    expect(h.audit.map((e) => e.action)).toEqual(["TEAM_MEMBER_REMOVED", "TEAM_LEAD_CHANGED"])
    expect(h.bumps).toEqual(["lead"])
    await expect(h.service.removeMember("net", "lead")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

describe("TeamsService.setLead", () => {
  it("is an admin's call, not a lead's", async () => {
    await expect(harness({ ...base, actor: { id: "lead", role: "AGENT", leads: ["net"] } }).service.setLead("net", "agent")).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("moves the lead to another member, bumping both", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await h.service.addMember("net", "agent")
    h.bumps.length = 0
    const team = await h.service.setLead("net", "agent")
    expect(team.lead?.membershipId).toBe("agent")
    expect(h.bumps).toEqual(["lead", "agent"])
    expect(h.audit.at(-1)).toMatchObject({ action: "TEAM_LEAD_CHANGED", diff: { lead: { from: "lead", to: "agent" } } })
  })

  it("requires the new lead to be in the team already, and clears with null", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await expect(h.service.setLead("net", "agent")).rejects.toBeInstanceOf(ConflictProblem)
    expect((await h.service.setLead("net", null)).lead).toBeNull()
    expect(h.bumps).toEqual(["lead"])
  })

  it("setting the current lead again changes nothing", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await h.service.setLead("net", "lead")
    expect(h.audit).toEqual([])
  })
})

describe("TeamsService create and update", () => {
  it("names are unique per organization", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await expect(h.service.create({ name: "Network" })).rejects.toBeInstanceOf(ConflictProblem)
    expect((await h.service.create({ name: "Field" })).name).toBe("Field")
    await expect(h.service.update("sec", { name: "Network" })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("audits only the fields that changed", async () => {
    const h = harness({ ...base, actor: { id: "a", role: "ADMIN" } })
    await h.service.update("sec", { name: "Security", isActive: false })
    expect(h.audit).toEqual([{ action: "TEAM_UPDATED", entityType: "Team", entityId: "sec", diff: { isActive: { from: true, to: false } } }])
    await h.service.update("sec", { isActive: false })
    expect(h.audit).toHaveLength(1)
  })

  it("agents read teams; requesters do not", async () => {
    await expect(harness({ ...base, actor: { id: "agent", role: "AGENT" } }).service.list()).resolves.toHaveLength(3)
    await expect(harness({ ...base, actor: { id: "req", role: "REQUESTER" } }).service.list()).rejects.toBeInstanceOf(NotPermittedProblem)
  })
})
