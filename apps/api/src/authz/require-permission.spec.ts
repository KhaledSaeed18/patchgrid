import type { ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Permission } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import type { Actor, ActorService } from "../auth/actor"
import { NotPermittedProblem } from "../common/problems/problem.exception"
import { PermissionService } from "./permission.service"
import { PermissionGuard, RequirePermission } from "./require-permission"

class Probe {
  open(): void {}

  @RequirePermission("member:invite")
  invite(): void {}
}

function guardFor(actor: Actor | undefined): PermissionGuard {
  const actors = { current: () => actor } as unknown as ActorService
  return new PermissionGuard(new Reflector(), actors, new PermissionService())
}

const context = (handler: () => void) =>
  ({ getHandler: () => handler, getClass: () => Probe }) as unknown as ExecutionContext

const member = (role: "OWNER" | "ADMIN" | "AGENT" | "REQUESTER"): Actor => ({
  kind: "member",
  userId: "u-1",
  orgId: "o-1",
  membershipId: "m-1",
  role,
  teamIds: [],
  leadOfTeamIds: [],
})

describe("PermissionGuard", () => {
  it("passes a route that names no permission — the coverage test owns that case", () => {
    expect(guardFor(undefined).canActivate(context(Probe.prototype.open))).toBe(true)
  })

  it("admits a role that may ever hold the permission", () => {
    expect(guardFor(member("ADMIN")).canActivate(context(Probe.prototype.invite))).toBe(true)
  })

  it("refuses with 403 a role that never may, and an actor outside a tenant", () => {
    for (const actor of [member("AGENT"), { kind: "identity", userId: "u-1" } as const, undefined]) {
      expect(() => guardFor(actor).canActivate(context(Probe.prototype.invite))).toThrow(NotPermittedProblem)
    }
  })

  it("lets a conditional grant through to the service, which decides on the subject", () => {
    class Lead {
      @RequirePermission("team:manage_own_members" satisfies Permission)
      manage(): void {}
    }
    const ctx = { getHandler: () => Lead.prototype.manage, getClass: () => Lead } as unknown as ExecutionContext
    expect(guardFor(member("AGENT")).canActivate(ctx)).toBe(true)
  })
})
