import type { Role } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import type { MemberActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { memberCapabilities } from "./member-capabilities"

const permissions = new PermissionService()
const actor = (role: Role): MemberActor => ({
  kind: "member",
  userId: "u-me",
  orgId: "o-1",
  membershipId: "m-me",
  role,
  teamIds: [],
  leadOfTeamIds: [],
})
const member = (
  role: Role,
  over: Partial<{ id: string; status: "ACTIVE" | "DISABLED" | "REMOVED" | "INVITED"; kind: "HUMAN" | "SERVICE_ACCOUNT" | "EXTERNAL" }> = {},
) => ({
  id: "m-them",
  role,
  status: "ACTIVE" as const,
  kind: "HUMAN" as const,
  ...over,
})

describe("memberCapabilities (RBAC.md §6)", () => {
  it("gives an owner every role and every action on anyone else", () => {
    expect(memberCapabilities(permissions, actor("OWNER"), member("ADMIN"))).toEqual({
      roles: ["REQUESTER", "AGENT", "ADMIN", "OWNER"],
      canDisable: true,
      canEnable: false,
      canRemove: true,
    })
  })

  it("stops an admin short of owners and other admins' roles, and of themselves", () => {
    expect(memberCapabilities(permissions, actor("ADMIN"), member("AGENT"))).toEqual({
      roles: ["REQUESTER", "AGENT"],
      canDisable: true,
      canEnable: false,
      canRemove: true,
    })
    expect(memberCapabilities(permissions, actor("ADMIN"), member("OWNER"))).toEqual({
      roles: [],
      canDisable: false,
      canEnable: false,
      canRemove: false,
    })
    // An admin may pause another admin but not change their role: setting ADMIN is the owners'.
    expect(memberCapabilities(permissions, actor("ADMIN"), member("ADMIN")).roles).toEqual([])
    expect(memberCapabilities(permissions, actor("ADMIN"), member("AGENT", { id: "m-me" }))).toEqual({
      roles: [],
      canDisable: false,
      canEnable: false,
      canRemove: false,
    })
  })

  it("offers restoring a paused member, not pausing them again", () => {
    expect(memberCapabilities(permissions, actor("OWNER"), member("AGENT", { status: "DISABLED" }))).toMatchObject({
      canDisable: false,
      canEnable: true,
    })
  })

  it("offers nothing on a service account, a removed member, or to an agent", () => {
    const none = { roles: [], canDisable: false, canEnable: false, canRemove: false }
    expect(memberCapabilities(permissions, actor("OWNER"), member("AGENT", { kind: "SERVICE_ACCOUNT" }))).toEqual(none)
    expect(memberCapabilities(permissions, actor("OWNER"), member("AGENT", { status: "REMOVED" }))).toEqual(none)
    expect(memberCapabilities(permissions, actor("AGENT"), member("REQUESTER"))).toEqual(none)
  })

  it("lets an admin pause or remove an external requester, and never give them a role", () => {
    expect(memberCapabilities(permissions, actor("ADMIN"), member("REQUESTER", { kind: "EXTERNAL" }))).toEqual({
      roles: [],
      canDisable: true,
      canEnable: false,
      canRemove: true,
    })
    expect(memberCapabilities(permissions, actor("AGENT"), member("REQUESTER", { kind: "EXTERNAL" }))).toEqual({
      roles: [],
      canDisable: false,
      canEnable: false,
      canRemove: false,
    })
  })
})
