import {
  grantFor,
  type Permission,
  type PermissionCondition,
  PERMISSION_CONDITIONS,
  PERMISSIONS,
  type Role,
  roleSchema,
  SCOPE_GRANTS,
  TOKEN_FORBIDDEN_FAMILIES,
  type TokenScope,
  tokenScopeSchema,
} from "@patchgrid/contracts"
import { Logger } from "@nestjs/common"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Actor, MemberActor, ServiceActor } from "../auth/actor"
import { NotFoundProblem, NotPermittedProblem } from "../common/problems/problem.exception"
import { PermissionService } from "./permission.service"
import type { Subject } from "./subject"

/**
 * The exhaustive matrix test (RBAC.md §13.1). Every (role, permission) pair is
 * driven through `can()` with subjects that satisfy, and subjects that fail,
 * each condition its grant names. The expected grant comes from the catalog —
 * whose agreement with RBAC.md is `@patchgrid/contracts`' own test — so what is
 * proven here is that `can()` evaluates the table faithfully, including that
 * absence of a fact never grants.
 */

const service = new PermissionService()

function member(role: Role, overrides: Partial<MemberActor> = {}): MemberActor {
  return {
    kind: "member",
    userId: "u-1",
    orgId: "o-1",
    membershipId: "m-1",
    role,
    teamIds: [],
    leadOfTeamIds: [],
    ...overrides,
  }
}

function token(role: Role, scopes: TokenScope[]): ServiceActor {
  return { kind: "service", orgId: "o-1", membershipId: "m-svc", role, scopes }
}

/** For each condition: subjects that satisfy it, and subjects that must not. */
const FIXTURES: Record<PermissionCondition, { pass: Subject[]; fail: Subject[] }> = {
  own: { pass: [{ own: true }], fail: [{}, { own: false }] },
  watch: { pass: [{ watch: true }], fail: [{}, { watch: false }] },
  scope: { pass: [{ scope: true }], fail: [{}, { scope: false }] },
  lead: { pass: [{ lead: true }], fail: [{}, { lead: false }] },
  self: { pass: [{ self: true }], fail: [{}, { self: false }] },
  own_while_new: {
    pass: [{ own: true, ticketStatus: "NEW" }],
    fail: [{ own: true }, { own: true, ticketStatus: "ASSIGNED" }, { own: false, ticketStatus: "NEW" }],
  },
  user_facing_type: {
    pass: [{ ticketType: "INCIDENT" }, { ticketType: "SERVICE_REQUEST" }],
    fail: [{}, { ticketType: "PROBLEM" }, { ticketType: "CHANGE" }],
  },
  lead_not_own: {
    pass: [{ lead: true, own: false }],
    fail: [{ lead: true }, { lead: true, own: true }, { lead: false, own: false }],
  },
  not_own: { pass: [{ own: false }], fail: [{}, { own: true }] },
  below_admin_not_self: {
    pass: [
      { self: false, targetRole: "AGENT" },
      { self: false, targetRole: "REQUESTER" },
    ],
    fail: [
      { targetRole: "AGENT" },
      { self: true, targetRole: "AGENT" },
      { self: false, targetRole: "ADMIN" },
      { self: false, targetRole: "OWNER" },
      { self: false },
    ],
  },
  not_owner_not_self: {
    pass: [
      { self: false, targetRole: "ADMIN" },
      { self: false, targetRole: "AGENT" },
      { self: false, targetRole: "REQUESTER" },
    ],
    fail: [{ targetRole: "AGENT" }, { self: true, targetRole: "AGENT" }, { self: false, targetRole: "OWNER" }, { self: false }],
  },
  self_within_window: {
    pass: [{ self: true, withinEditWindow: true }],
    fail: [{ self: true }, { self: true, withinEditWindow: false }, { self: false, withinEditWindow: true }],
  },
  own_within_window: {
    pass: [{ own: true, withinEditWindow: true }],
    fail: [{ own: true }, { own: true, withinEditWindow: false }, { own: false, withinEditWindow: true }],
  },
}

/** Every fact asserted at once — enough to satisfy any condition that is not a negation. */
const EVERYTHING: Subject = {
  own: true,
  watch: true,
  scope: true,
  lead: true,
  self: true,
  ticketType: "INCIDENT",
  ticketStatus: "NEW",
  targetRole: "REQUESTER",
  withinEditWindow: true,
}

const ROLES = roleSchema.options
const PAIRS = ROLES.flatMap((role) => PERMISSIONS.map((permission) => [role, permission] as const))

describe("PermissionService.can — the matrix", () => {
  it("has a fixture for every condition the catalog can name", () => {
    expect(Object.keys(FIXTURES).toSorted()).toEqual([...PERMISSION_CONDITIONS].toSorted())
  })

  it.each(PAIRS)("%s × %s", (role: Role, permission: Permission) => {
    const actor = member(role)
    const grant = grantFor(role, permission)

    if (grant === true) {
      expect(service.can(actor, permission)).toBe(true)
      expect(service.can(actor, permission, {})).toBe(true)
      return
    }
    if (grant === false) {
      expect(service.can(actor, permission)).toBe(false)
      expect(service.can(actor, permission, EVERYTHING)).toBe(false)
      expect(service.can(actor, permission, { ...EVERYTHING, own: false, self: false })).toBe(false)
      return
    }

    // Conditional: never without a subject, never on an empty one.
    expect(service.can(actor, permission)).toBe(false)
    expect(service.can(actor, permission, {})).toBe(false)
    for (const condition of grant) {
      for (const subject of FIXTURES[condition].pass) {
        expect(service.can(actor, permission, subject), `${condition} ${JSON.stringify(subject)}`).toBe(true)
      }
      for (const subject of FIXTURES[condition].fail) {
        const others = grant.filter((c) => c !== condition)
        const othersPass = others.some((c) => FIXTURES[c].pass.some((p) => matches(p, subject)))
        if (othersPass) continue
        expect(service.can(actor, permission, subject), `${condition} ${JSON.stringify(subject)}`).toBe(false)
      }
    }
  })
})

/** `subject` carries every fact `pattern` asserts. */
function matches(pattern: Subject, subject: Subject): boolean {
  return Object.entries(pattern).every(([k, v]) => subject[k as keyof Subject] === v)
}

describe("PermissionService.can — deny by default", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("denies an unknown permission and logs it", () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    expect(service.can(member("OWNER"), "ticket:obliterate" as Permission)).toBe(false)
    expect(error).toHaveBeenCalledOnce()
  })

  it("denies an actor outside a tenant, and no actor at all", () => {
    const identity: Actor = { kind: "identity", userId: "u-1" }
    for (const permission of PERMISSIONS) {
      expect(service.can(identity, permission, EVERYTHING)).toBe(false)
      expect(service.can(undefined, permission, EVERYTHING)).toBe(false)
    }
    expect(service.permissionsFor(identity)).toEqual([])
  })
})

describe("PermissionService — escalation negatives (RBAC.md §13.6)", () => {
  const admin = member("ADMIN")

  it("an admin cannot change their own role, an admin's, or an owner's", () => {
    expect(service.can(admin, "member:update_role", { self: true, targetRole: "ADMIN" })).toBe(false)
    expect(service.can(admin, "member:update_role", { self: false, targetRole: "ADMIN" })).toBe(false)
    expect(service.can(admin, "member:update_role", { self: false, targetRole: "OWNER" })).toBe(false)
    expect(service.can(admin, "member:update_role", { self: false, targetRole: "AGENT" })).toBe(true)
  })

  it("only an owner may raise anyone to admin or owner", () => {
    expect(service.can(admin, "member:promote_admin")).toBe(false)
    expect(service.can(member("OWNER"), "member:promote_admin")).toBe(true)
  })

  it("an admin may disable or remove another admin, never an owner, never themselves", () => {
    for (const permission of ["member:disable", "member:remove"] as const) {
      expect(service.can(admin, permission, { self: false, targetRole: "ADMIN" })).toBe(true)
      expect(service.can(admin, permission, { self: false, targetRole: "OWNER" })).toBe(false)
      expect(service.can(admin, permission, { self: true, targetRole: "ADMIN" })).toBe(false)
    }
  })

  it("a lead cannot approve their own change, and leading grants an agent nothing else", () => {
    const lead = member("AGENT", { leadOfTeamIds: ["t-1"], teamIds: ["t-1"] })
    expect(service.can(lead, "ticket:approve_change", { lead: true, own: true })).toBe(false)
    expect(service.can(lead, "ticket:approve_change", { lead: true, own: false })).toBe(true)
    expect(service.can(lead, "member:invite")).toBe(false)
    expect(service.can(lead, "member:update_role", { self: false, targetRole: "REQUESTER" })).toBe(false)
  })

  it("assert is a 403 and assertVisible a 404", () => {
    expect(() => service.assert(member("REQUESTER"), "member:invite")).toThrow(NotPermittedProblem)
    expect(() => service.assertVisible(member("REQUESTER"), "ticket:read", { own: false })).toThrow(
      NotFoundProblem,
    )
    expect(() => service.assert(admin, "member:invite")).not.toThrow()
  })
})

describe("PermissionService — service accounts (RBAC.md §13.8)", () => {
  const scopeSets: TokenScope[][] = [
    [],
    ...tokenScopeSchema.options.map((s) => [s]),
    [...tokenScopeSchema.options],
    ["tickets:read", "tickets:write"],
  ]

  it.each(["AGENT", "REQUESTER", "ADMIN", "OWNER"] as const)(
    "effective permissions for a %s token are exactly role ∩ scopes",
    (role) => {
      for (const scopes of scopeSets) {
        const granted = new Set<Permission>(scopes.flatMap((s) => [...SCOPE_GRANTS[s]]))
        const expected = service.permissionsFor(member(role)).filter((p) => granted.has(p))
        expect(service.permissionsFor(token(role, scopes))).toEqual(expected)
      }
    },
  )

  it("never reaches a forbidden family, whatever the role and scopes", () => {
    const actor = token("OWNER", [...tokenScopeSchema.options])
    for (const permission of PERMISSIONS) {
      const family = permission.split(":")[0] as (typeof TOKEN_FORBIDDEN_FAMILIES)[number]
      if (TOKEN_FORBIDDEN_FAMILIES.includes(family)) {
        expect(service.can(actor, permission, EVERYTHING), permission).toBe(false)
      }
    }
  })

  it("cannot read internal notes without the opt-in scope", () => {
    const actor = token("AGENT", ["tickets:read", "tickets:write"])
    expect(service.can(actor, "comment:read_internal", { scope: true })).toBe(false)
    expect(service.can(token("AGENT", ["comments:internal"]), "comment:read_internal", { scope: true })).toBe(
      true,
    )
  })

  it("scopes never widen a role", () => {
    const actor = token("REQUESTER", ["tickets:write"])
    expect(service.can(actor, "ticket:assign", EVERYTHING)).toBe(false)
  })
})

describe("PermissionService.permissionsFor", () => {
  it("lists everything a role may ever do, conditions aside", () => {
    const requester = service.permissionsFor(member("REQUESTER"))
    expect(requester).toContain("ticket:read")
    expect(requester).toContain("ticket:create")
    expect(requester).not.toContain("ticket:assign")
    expect(service.permissionsFor(member("OWNER"))).toEqual(PERMISSIONS)
  })

  it("grows with each role", () => {
    const sizes = ROLES.toReversed().map((role) => service.permissionsFor(member(role)).length)
    expect(sizes).toEqual(sizes.toSorted((a, b) => a - b))
  })
})

describe("PermissionService.scopeFor (RBAC.md §4)", () => {
  const all = { agentVisibility: "ALL_TICKETS" } as const
  const own = { agentVisibility: "OWN_TEAM_ONLY" } as const

  it("admins and owners see every ticket whatever the setting", () => {
    for (const role of ["ADMIN", "OWNER"] as const) {
      expect(service.scopeFor(member(role), "ticket", own)).toEqual({ kind: "all" })
    }
  })

  it("an agent sees every ticket under ALL_TICKETS", () => {
    expect(service.scopeFor(member("AGENT", { teamIds: ["t-1"] }), "ticket", all)).toEqual({ kind: "all" })
  })

  it("an OWN_TEAM_ONLY agent in several teams gets four branches, the teams as one", () => {
    const agent = member("AGENT", { teamIds: ["t-1", "t-2"] })
    expect(service.scopeFor(agent, "ticket", own)).toEqual({
      kind: "any",
      branches: [
        { kind: "teams", teamIds: ["t-1", "t-2"] },
        { kind: "no-team" },
        { kind: "assignee", membershipId: "m-1" },
        { kind: "watcher", membershipId: "m-1" },
      ],
    })
  })

  it("an OWN_TEAM_ONLY agent in no team has no team branch, never an empty IN ()", () => {
    const filter = service.scopeFor(member("AGENT"), "ticket", own)
    expect(filter.kind).toBe("any")
    if (filter.kind === "any") expect(filter.branches.map((b) => b.kind)).toEqual(["no-team", "assignee", "watcher"])
  })

  it("a requester sees what they raised and what they watch, whatever the setting", () => {
    const expected = {
      kind: "any",
      branches: [
        { kind: "requester", membershipId: "m-1" },
        { kind: "watcher", membershipId: "m-1" },
      ],
    }
    expect(service.scopeFor(member("REQUESTER"), "ticket", all)).toEqual(expected)
    expect(service.scopeFor(member("REQUESTER"), "ticket", own)).toEqual(expected)
  })

  it("a token without tickets:read sees no ticket at all", () => {
    expect(service.scopeFor(token("AGENT", ["assets:read"]), "ticket", all)).toEqual({ kind: "none" })
    expect(service.scopeFor(token("AGENT", ["tickets:read"]), "ticket", all)).toEqual({ kind: "all" })
  })

  it("assets: requesters see their own, agents all", () => {
    expect(service.scopeFor(member("REQUESTER"), "asset", all)).toEqual({
      kind: "any",
      branches: [{ kind: "owner", membershipId: "m-1" }],
    })
    expect(service.scopeFor(member("AGENT"), "asset", all)).toEqual({ kind: "all" })
    expect(service.scopeFor(token("AGENT", ["tickets:read"]), "asset", all)).toEqual({ kind: "none" })
  })

  it("nobody outside a tenant has a scope", () => {
    expect(service.scopeFor({ kind: "identity", userId: "u-1" }, "ticket", all)).toEqual({ kind: "none" })
  })
})
