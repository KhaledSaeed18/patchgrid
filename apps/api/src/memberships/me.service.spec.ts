import { describe, expect, it } from "vitest"

import type { Actor, ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { NotAuthenticatedProblem } from "../common/problems/problem.exception"
import type { OrganizationRepository } from "../platform/repositories/organization.repository"
import type { UserRepository } from "../platform/repositories/user.repository"
import type { SupportService } from "../support/support.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { MeService } from "./me.service"
import type { MembershipRepository, MemberRow } from "./repositories/membership.repository"

const tenant = { id: "o-1", slug: "acme", status: "ACTIVE", plan: "FREE", agentVisibility: "OWN_TEAM_ONLY", via: "cookie" }
const row: MemberRow = {
  id: "m-1",
  userId: "u-1",
  displayName: "Ada",
  avatarUrl: null,
  role: "AGENT",
  status: "ACTIVE",
  kind: "HUMAN",
  joinedAt: null,
  createdAt: new Date(0),
  teams: [{ id: "t-1", name: "Network", isLead: true }],
  contact: { email: "ada@acme.test", lastLoginAt: null },
}

function serviceFor(actor: Actor, member: MemberRow | null = row) {
  return new MeService(
    { findMember: async () => member } as unknown as MembershipRepository,
    { findById: async () => ({ id: "u-1", email: "ada@acme.test", name: "Ada L." }) } as unknown as UserRepository,
    { findProfileById: async () => ({ id: "o-1", name: "Acme", slug: "acme", status: "ACTIVE" }) } as unknown as OrganizationRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { organization: () => tenant } as unknown as TenantContextService,
    { stateFor: async (a: Actor) => (a.kind === "support" ? { kind: "operator", sessionId: "s-1", operatorName: "Olga", expiresAt: "2026-10-16T00:00:00.000Z" } : null) } as unknown as SupportService,
  )
}

const agent: Actor = { kind: "member", userId: "u-1", orgId: "o-1", membershipId: "m-1", role: "AGENT", teamIds: ["t-1"], leadOfTeamIds: ["t-1"] }

describe("MeService", () => {
  it("names an operator in a support session as support, with reads only and nothing to create", async () => {
    const support: Actor = { kind: "support", orgId: "o-1", sessionId: "s-1", platformAdminId: "pa-1", userId: "u-9", role: "ADMIN", membershipId: "s-1" }
    const me = await serviceFor(support, null).me()
    expect(me).toMatchObject({ user: null, membership: { role: "ADMIN", displayName: "Patchgrid support · Olga" }, creatableTypes: [], support: { kind: "operator" } })
    expect(me.permissions).toContain("comment:read_internal")
    expect(me.permissions.some((p) => /:(create|update|write|delete|assign)/.test(p))).toBe(false)
  })

  it("answers who, where, which teams, and the role-level permission list", async () => {
    const me = await serviceFor(agent).me()
    expect(me.user).toEqual({ id: "u-1", email: "ada@acme.test", name: "Ada L." })
    expect(me.membership).toEqual({ id: "m-1", role: "AGENT", displayName: "Ada", avatarUrl: null })
    expect(me.org).toEqual({ id: "o-1", name: "Acme", slug: "acme", plan: "FREE", agentVisibility: "OWN_TEAM_ONLY" })
    expect(me.teams).toEqual([{ id: "t-1", name: "Network", isLead: true }])
    expect(me.permissions).toContain("ticket:assign")
    expect(me.permissions).toContain("team:manage_own_members")
    expect(me.permissions).not.toContain("member:invite")
    expect(me.creatableTypes).toEqual(["INCIDENT", "SERVICE_REQUEST", "PROBLEM", "CHANGE"])
  })

  it("offers a requester only the types they may raise", async () => {
    const requester: Actor = { ...agent, role: "REQUESTER" } as Actor
    expect((await serviceFor(requester, { ...row, role: "REQUESTER" }).me()).creatableTypes).toEqual(["INCIDENT", "SERVICE_REQUEST"])
  })

  it("has no user for a service account, and only its scoped permissions", async () => {
    const me = await serviceFor({ kind: "service", orgId: "o-1", membershipId: "m-1", role: "AGENT", scopes: ["tickets:read"], tokenId: "tok-1" }).me()
    expect(me.user).toBeNull()
    expect(me.permissions.toSorted()).toEqual(["attachment:download", "category:read", "ticket:read", "ticket:read_audit"])
  })

  it("ends the session when the membership vanished between the guard and the read", async () => {
    await expect(serviceFor(agent, null).me()).rejects.toBeInstanceOf(NotAuthenticatedProblem)
  })
})
