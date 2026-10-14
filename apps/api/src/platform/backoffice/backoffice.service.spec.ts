import { describe, expect, it, vi } from "vitest"

import type { ActorService, PlatformActor } from "../../auth/actor"
import type { RevocationEpochService } from "../../auth/revocation/revocation-epoch.service"
import type { AuditService } from "../../audit/audit.service"
import { ConflictProblem, NotAuthenticatedProblem, NotFoundProblem } from "../../common/problems/problem.exception"
import type { PrismaService } from "../../prisma/prisma.service"
import type { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import type { PlatformAuditRepository } from "../repositories/platform-audit.repository"
import { BackofficeService } from "./backoffice.service"
import type { BackofficeRepository, OrgRow } from "./repositories/backoffice.repository"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const org: OrgRow = { id: ORG, name: "Acme", slug: "acme", status: "ACTIVE", plan: "FREE", domain: null, createdAt: new Date(0) }

function harness(actor: PlatformActor | undefined, row: OrgRow | null = org, moved = true) {
  const repo = {
    find: vi.fn(async () => row),
    moveStatus: vi.fn(async () => moved),
    setPlan: vi.fn(async () => undefined),
    activeMembers: vi.fn(async () => new Map([[ORG, 3]])),
    countsIn: vi.fn(async () => ({ seats: 2, requesters: 1, tickets: 0, openTickets: 0, assets: 0, articles: 0, storageBytes: 0 })),
    membershipIdsIn: vi.fn(async () => ["m-1", "m-2"]),
  }
  const epochs = { bump: vi.fn(async () => undefined) }
  const audit = { record: vi.fn(async () => undefined) }
  const platformAudit = { record: vi.fn(async () => undefined) }
  const service = new BackofficeService(
    repo as unknown as BackofficeRepository,
    { invalidate: vi.fn(async () => undefined) } as unknown as OrganizationLookupService,
    epochs as unknown as RevocationEpochService,
    audit as unknown as AuditService,
    platformAudit as unknown as PlatformAuditRepository,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    {
      requirePlatform: () => {
        if (actor === undefined) throw new NotAuthenticatedProblem()
        return actor
      },
    } as unknown as ActorService,
  )
  return { service, repo, epochs, audit, platformAudit }
}

const operator: PlatformActor = { kind: "platform", platformAdminId: "pa-1", userId: "u-1", sessionExpiresAt: 0 }

describe("BackofficeService", () => {
  it("answers only an operator", async () => {
    await expect(harness(undefined).service.list({ limit: 25 })).rejects.toBeInstanceOf(NotAuthenticatedProblem)
  })

  it("suspends an active workspace, ending every member's sessions, and audits it twice", async () => {
    const h = harness(operator)
    await h.service.suspend(ORG, "abuse")
    expect(h.repo.moveStatus).toHaveBeenCalledWith(ORG, "ACTIVE", "SUSPENDED")
    expect(h.epochs.bump.mock.calls).toEqual([["m-1"], ["m-2"]])
    expect(h.audit.record).toHaveBeenCalledWith(ORG, [expect.objectContaining({ action: "ORG_SUSPENDED", diff: { reason: "abuse" } })])
    expect(h.platformAudit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "PLATFORM_ORG_SUSPENDED", platformAdminId: "pa-1" }))
  })

  it("refuses to suspend what is not active, and a workspace that does not exist", async () => {
    await expect(harness(operator, org, false).service.suspend(ORG, "x")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness(operator, null).service.get(ORG)).rejects.toBeInstanceOf(NotFoundProblem)
  })

  it("sets a plan once, and records nothing when it is already that plan", async () => {
    const same = harness(operator)
    await same.service.setPlan(ORG, "FREE")
    expect(same.repo.setPlan).not.toHaveBeenCalled()
    expect(same.audit.record).not.toHaveBeenCalled()
    const pro = harness(operator)
    await pro.service.setPlan(ORG, "PRO")
    expect(pro.audit.record).toHaveBeenCalledWith(ORG, [expect.objectContaining({ action: "ORG_PLAN_CHANGED", diff: { plan: { from: "FREE", to: "PRO" } } })])
  })
})
