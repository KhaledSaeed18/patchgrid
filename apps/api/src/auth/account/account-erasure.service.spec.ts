import { describe, expect, it, vi } from "vitest"

import type { AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, ValidationProblem } from "../../common/problems/problem.exception"
import type { MailService } from "../../mail/mail.service"
import type { MembershipRepository } from "../../memberships/repositories/membership.repository"
import type { OrganizationRepository } from "../../platform/repositories/organization.repository"
import type { PlatformAdminRepository } from "../../platform/repositories/platform-admin.repository"
import type { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import type { UserRepository } from "../../platform/repositories/user.repository"
import type { PrismaService } from "../../prisma/prisma.service"
import type { QuotaService } from "../../quota/quota.service"
import type { PasswordService } from "../passwords/password.service"
import type { RevocationEpochService } from "../revocation/revocation-epoch.service"
import type { SessionService } from "../sessions/session.service"
import { AccountErasureService } from "./account-erasure.service"
import type { AccountErasureRepository } from "./repositories/account-erasure.repository"

vi.mock("../../platform/run-as-tenant", () => ({ runAsTenant: (_o: string, _c: unknown, fn: () => Promise<unknown>) => fn() }))
vi.mock("../../platform/run-as-platform", () => ({ runAsPlatform: (_c: unknown, fn: () => Promise<unknown>) => fn() }))

const ORG = "0190b2f0-0000-7000-8000-00000000000a"

function harness(options: { password?: boolean; admin?: boolean; owners?: number; role?: "OWNER" | "AGENT"; orgStatus?: string } = {}) {
  const sessions = { revokeEverywhere: vi.fn(async () => [{ name: "pg_id", path: "/" }]) }
  const erasure = { anonymiseMembership: vi.fn(async () => undefined), forgetPresence: vi.fn(async () => undefined), tombstoneAccount: vi.fn(async () => undefined) }
  const service = new AccountErasureService(
    erasure as unknown as AccountErasureRepository,
    { findById: async () => ({ id: "u-1", email: "sam@acme.test", name: "Sam", passwordHash: "h", emailVerifiedAt: new Date(0), anonymisedAt: null }) } as unknown as UserRepository,
    { allOrgIdsForUser: async () => [ORG] } as unknown as UserOrgIndexRepository,
    { findProfileById: async () => ({ id: ORG, name: "Acme", slug: "acme", status: options.orgStatus ?? "ACTIVE" }) } as unknown as OrganizationRepository,
    { activeForUser: async () => (options.admin === true ? { id: "pa" } : null) } as unknown as PlatformAdminRepository,
    {
      findByUser: async () => ({ id: "m-1", role: options.role ?? "AGENT", status: "ACTIVE", kind: "HUMAN" }),
      countActiveOwners: async () => options.owners ?? 1,
      lockOrganization: async () => undefined,
      leaveAllTeams: async () => [],
    } as unknown as MembershipRepository,
    { verify: async () => options.password ?? true } as unknown as PasswordService,
    sessions as unknown as SessionService,
    { bump: vi.fn(async () => undefined) } as unknown as RevocationEpochService,
    { release: vi.fn(async () => undefined) } as unknown as QuotaService,
    { record: vi.fn(async () => undefined) } as unknown as AuditService,
    { enqueue: vi.fn(async () => undefined) } as unknown as MailService,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    new FixedClock(new Date("2026-10-15T12:00:00Z")),
  )
  return { service, sessions, erasure }
}

describe("AccountErasureService", () => {
  it("refuses a wrong password, a platform grant, and a last owner — before ending any session", async () => {
    for (const [options, problem] of [
      [{ password: false }, ValidationProblem],
      [{ admin: true }, ConflictProblem],
      [{ role: "OWNER" as const, owners: 1 }, ConflictProblem],
    ] as const) {
      const h = harness(options)
      await expect(h.service.erase("u-1", "pw")).rejects.toBeInstanceOf(problem)
      expect(h.sessions.revokeEverywhere).not.toHaveBeenCalled()
    }
  })

  it("lets a last owner go when the workspace is already being deleted, or when another owner remains", async () => {
    for (const options of [{ role: "OWNER" as const, owners: 1, orgStatus: "PENDING_DELETION" }, { role: "OWNER" as const, owners: 2 }]) {
      const h = harness(options)
      await h.service.erase("u-1", "pw")
      expect(h.erasure.anonymiseMembership).toHaveBeenCalled()
      expect(h.erasure.tombstoneAccount).toHaveBeenCalledWith("u-1", expect.stringMatching(/^deleted\+[0-9a-f]{16}@invalid$/), expect.any(Date))
    }
  })
})
