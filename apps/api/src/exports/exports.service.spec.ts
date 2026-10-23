import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { NotPermittedProblem, RateLimitedProblem } from "../common/problems/problem.exception"
import type { MembershipRepository } from "../memberships/repositories/membership.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { StorageService } from "../storage/storage.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { ExportsService } from "./exports.service"
import type { OrgExportRepository } from "./repositories/org-export.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T12:00:00Z")
const HOUR = 60 * 60_000

function harness(role: MemberActor["role"], last: Date | null) {
  const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId: "m-1", role, teamIds: [], leadOfTeamIds: [] }
  const exportsRepo = {
    latestCounted: vi.fn(async () => last),
    create: vi.fn(async () => "x-1"),
    find: vi.fn(async () => ({
      id: "x-1",
      status: "QUEUED",
      requestedAt: NOW,
      readyAt: null,
      expiresAt: null,
      sizeBytes: null,
      storageKey: null,
      failure: null,
      requestedBy: { id: "m-1", displayName: "Alice", user: null },
    })),
  }
  const queue = { add: vi.fn(async () => undefined) }
  const service = new ExportsService(
    exportsRepo as unknown as OrgExportRepository,
    { lockOrganization: vi.fn(async () => undefined) } as unknown as MembershipRepository,
    {} as StorageService,
    { record: vi.fn(async () => undefined) } as unknown as AuditService,
    new PermissionService(),
    { requireMember: () => actor, requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    queue as never,
    new FixedClock(NOW),
  )
  return { service, exportsRepo, queue }
}

describe("ExportsService.request", () => {
  it("queues an owner's export, one job per export", async () => {
    const h = harness("OWNER", new Date(NOW.getTime() - 25 * HOUR))
    expect((await h.service.request()).status).toBe("QUEUED")
    expect(h.queue.add).toHaveBeenCalledWith(
      "org-export",
      { orgId: ORG, exportId: "x-1" },
      expect.objectContaining({ jobId: "org-export/o-1/x-1/build", attempts: 1 }),
    )
  })

  it("is an owner's alone", async () => {
    await expect(harness("ADMIN", null).service.request()).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("allows one a day, and says how long to wait", async () => {
    const h = harness("OWNER", new Date(NOW.getTime() - 23 * HOUR))
    const refused = await h.service.request().catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(RateLimitedProblem)
    expect((refused as RateLimitedProblem).retryAfterSeconds).toBe(3600)
    expect(h.exportsRepo.create).not.toHaveBeenCalled()
  })
})
