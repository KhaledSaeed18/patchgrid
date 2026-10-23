import { describe, expect, it, vi } from "vitest"

import type { AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem, ValidationProblem } from "../../common/problems/problem.exception"
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
import { PublicUrls } from "../../common/urls"
import type { AppConfig } from "../../config/app-config"
import { AccountErasureService } from "./account-erasure.service"
import type { ErasureLinks } from "./erasure-links"
import type { AccountErasureRepository } from "./repositories/account-erasure.repository"

vi.mock("../../platform/run-as-tenant", () => ({ runAsTenant: (_o: string, _c: unknown, fn: () => Promise<unknown>) => fn() }))
vi.mock("../../platform/run-as-platform", () => ({ runAsPlatform: (_c: unknown, fn: () => Promise<unknown>) => fn() }))

const ORG = "0190b2f0-0000-7000-8000-00000000000a"

function harness(options: { password?: boolean; admin?: boolean; owners?: number; role?: "OWNER" | "AGENT"; orgStatus?: string; account?: "live" | "unverified" | "none" } = {}) {
  const account = { id: "u-1", email: "sam@acme.test", name: "Sam", passwordHash: "h", emailVerifiedAt: options.account === "unverified" ? null : new Date(0), anonymisedAt: null }
  const stored = new Map<string, string>()
  const links = {
    put: vi.fn(async (secret: string, userId: string) => void stored.set(secret, userId)),
    take: vi.fn(async (secret: string) => {
      const userId = stored.get(secret) ?? null
      stored.delete(secret)
      return userId
    }),
  }
  const mail = { enqueue: vi.fn(async () => undefined) }
  const sessions = { revokeEverywhere: vi.fn(async () => [{ name: "pg_id", path: "/" }]) }
  const erasure = {
    isAnonymised: vi.fn(async () => false),
    anonymiseMembership: vi.fn(async () => undefined),
    forgetPresence: vi.fn(async () => undefined),
    forgetInvitations: vi.fn(async () => undefined),
    forgetInboundSenders: vi.fn(async () => undefined),
    tombstoneAccount: vi.fn(async () => undefined),
  }
  const service = new AccountErasureService(
    erasure as unknown as AccountErasureRepository,
    { findById: async () => account, findByEmail: async () => (options.account === "none" ? null : account) } as unknown as UserRepository,
    { allOrgIdsForUser: async () => [ORG], markRemoved: vi.fn(async () => undefined) } as unknown as UserOrgIndexRepository,
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
    mail as unknown as MailService,
    links as unknown as ErasureLinks,
    new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], WEB_APP_PORT: 3001, PORT: 4000, isProduction: false } as AppConfig),
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    new FixedClock(new Date("2026-10-15T12:00:00Z")),
  )
  return { service, sessions, erasure, mail, links }
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
      // Invitations to the address name the person too.
      expect(h.erasure.forgetInvitations).toHaveBeenCalledWith(ORG, "sam@acme.test", "deleted+u-1@invalid")
      expect(h.erasure.tombstoneAccount).toHaveBeenCalledWith("u-1", "deleted+u-1@invalid", expect.any(Date))
    }
  })

  it("skips a workspace an earlier, interrupted attempt already erased: no second audit row, no second seat", async () => {
    const h = harness()
    h.erasure.isAnonymised.mockResolvedValue(true)
    await h.service.erase("u-1", "pw")
    expect(h.erasure.anonymiseMembership).not.toHaveBeenCalled()
    expect(h.erasure.tombstoneAccount).toHaveBeenCalled()
  })

  it("mails a single-use erasure link to a live account's address, and nothing to anyone else", async () => {
    const h = harness()
    await h.service.requestLink("sam@acme.test")
    expect(h.mail.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "confirm-erasure", to: "sam@acme.test", params: expect.objectContaining({ confirmUrl: expect.stringMatching(/^http:\/\/app\.lvh\.me:3001\/erase-account\?token=[A-Za-z0-9_-]{43}$/) }) }),
      expect.any(String),
    )
    for (const account of ["none", "unverified"] as const) {
      const quiet = harness({ account })
      await quiet.service.requestLink("sam@acme.test")
      expect(quiet.mail.enqueue).not.toHaveBeenCalled()
    }
  })

  it("erases the account the link names, once, with no password asked", async () => {
    const h = harness({ password: false })
    await h.service.requestLink("sam@acme.test")
    const secret = h.links.put.mock.calls[0]?.[0] ?? ""
    await h.service.confirmLink(secret)
    expect(h.erasure.tombstoneAccount).toHaveBeenCalledWith("u-1", "deleted+u-1@invalid", expect.any(Date))
    await expect(h.service.confirmLink(secret)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
  })

  it("still refuses a last owner by link, before any session ends", async () => {
    const h = harness({ role: "OWNER", owners: 1 })
    await h.service.requestLink("sam@acme.test")
    await expect(h.service.confirmLink(h.links.put.mock.calls[0]?.[0] ?? "")).rejects.toBeInstanceOf(ConflictProblem)
    expect(h.sessions.revokeEverywhere).not.toHaveBeenCalled()
  })
})
