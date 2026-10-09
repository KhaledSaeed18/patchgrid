import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { OrgAuditService } from "./org-audit.service"
import type { AuditListRow, AuditLogRepository } from "./repositories/audit-log.repository"

const row = (id: string, at: string): AuditListRow => ({
  id,
  action: "MEMBER_DISABLED",
  entityType: "Membership",
  entityId: "0190b2f0-0000-7000-8000-000000000009",
  diff: { status: { from: "ACTIVE", to: "DISABLED" } },
  actorKind: "MEMBER",
  actorMembershipId: "m-1",
  actorDisplayName: "Ada",
  createdAt: new Date(at),
})

function serviceFor(role: Role, rows: AuditListRow[] = []) {
  const list = vi.fn(async () => rows)
  const service = new OrgAuditService(
    { list } as unknown as AuditLogRepository,
    new PermissionService(),
    { requireTenantActor: () => ({ kind: "member", userId: "u", orgId: "o-1", membershipId: "m-1", role, teamIds: [], leadOfTeamIds: [] }) } as unknown as ActorService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
  )
  return { service, list }
}

describe("OrgAuditService", () => {
  it("is for admins and owners", async () => {
    await expect(serviceFor("AGENT").service.list({ limit: 25 })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("pages newest first with an opaque cursor, asking for one row more than it returns", async () => {
    const { service, list } = serviceFor("ADMIN", [row("a-3", "2026-10-09T03:00:00Z"), row("a-2", "2026-10-09T02:00:00Z"), row("a-1", "2026-10-09T01:00:00Z")])
    const page = await service.list({ limit: 2, action: "MEMBER_DISABLED", from: "2026-10-01T00:00:00Z" })
    expect(page.items.map((e) => e.id)).toEqual(["a-3", "a-2"])
    expect(page.items[0]?.actor).toEqual({ kind: "MEMBER", membershipId: "m-1", displayName: "Ada" })
    expect(list).toHaveBeenLastCalledWith("o-1", expect.objectContaining({ limit: 3, action: "MEMBER_DISABLED", from: new Date("2026-10-01T00:00:00Z"), before: null }))

    await service.list({ limit: 2, cursor: page.nextCursor ?? "" })
    expect(list).toHaveBeenLastCalledWith("o-1", expect.objectContaining({ before: { createdAt: new Date("2026-10-09T02:00:00Z"), id: "a-2" } }))
  })

  it("has no next cursor on the last page, and refuses a cursor it did not issue", async () => {
    const { service } = serviceFor("OWNER", [row("a-1", "2026-10-09T01:00:00Z")])
    expect((await service.list({ limit: 2 })).nextCursor).toBeNull()
    await expect(service.list({ limit: 2, cursor: "garbage" })).rejects.toBeInstanceOf(ValidationProblem)
  })
})
