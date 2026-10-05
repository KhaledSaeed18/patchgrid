import { Logger } from "@nestjs/common"
import { ClsServiceManager } from "nestjs-cls"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import {
  NotAuthenticatedProblem,
  NotFoundProblem,
  NotPermittedProblem,
  OrganizationSuspendedProblem,
  TenantMismatchProblem,
} from "../../common/problems/problem.exception"
import type { AppConfig } from "../../config/app-config"
import type {
  MembershipRecord,
  MembershipRepository,
} from "../../memberships/repositories/membership.repository"
import type { OrganizationSummary } from "../../platform/repositories/organization.repository"
import type {
  NewRefreshToken,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from "../../platform/repositories/refresh-token.repository"
import type { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { OrganizationLookup } from "../../tenancy/organization-lookup"
import type { RequestContextStore } from "../../tenancy/request-context"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { CookieService, type CookieSpec } from "../cookies"
import type { PasswordService } from "../passwords/password.service"
import type { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { AccessTokenService } from "../tokens/access-token.service"
import { hash, SessionService } from "./session.service"

const config = {
  JWT_SECRET: "local-development-secret-that-is-at-least-32-chars",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 7,
  COOKIE_DOMAIN: ".lvh.me",
  isProduction: false,
} as AppConfig

const acme: OrganizationSummary = { id: "0190b2f0-0000-7000-8000-00000000000a", slug: "acme", status: "ACTIVE", plan: "FREE", agentVisibility: "ALL_TICKETS" }
const globex: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000b", slug: "globex" }
const frozen: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000f", slug: "frozen", status: "SUSPENDED" }
const ORGS = [acme, globex, frozen]

const owner: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "owner@acme.test", name: "Owner", passwordHash: "$argon2id$owner", emailVerifiedAt: new Date("2026-01-01T00:00:00Z"), anonymisedAt: null }
const unverified: AccountRecord = { ...owner, id: "0190b2f0-0000-7000-8000-000000000002", email: "new@acme.test", passwordHash: "$argon2id$new", emailVerifiedAt: null }
const ACCOUNTS = [owner, unverified]

const membership = (orgId: string, status: MembershipRecord["status"] = "ACTIVE"): MembershipRecord => ({
  id: `0190b2f0-0000-7000-8000-00000000${orgId.slice(-2)}aa`,
  orgId,
  userId: owner.id,
  role: "OWNER",
  status,
  kind: "HUMAN",
  displayName: "Owner",
  teamIds: [],
  leadOfTeamIds: [],
})

function harness(memberships: MembershipRecord[] = [membership(acme.id)]) {
  const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
  const tokens = new Map<string, RefreshTokenRecord>()
  let nextId = 0
  const refreshTokens = {
    create: vi.fn(async (t: NewRefreshToken) => store(t)),
    findByHash: vi.fn(async (h: string) => tokens.get(h) ?? null),
    rotate: vi.fn(async (previousId: string, next: NewRefreshToken, at: Date) => {
      const created = store(next)
      const previous = [...tokens.values()].find((t) => t.id === previousId)
      if (previous) Object.assign(previous, { replacedById: created.id, revokedAt: at })
      return created
    }),
    revoke: vi.fn(async (id: string, at: Date) => {
      const row = [...tokens.values()].find((t) => t.id === id)
      if (row && row.revokedAt === null) row.revokedAt = at
    }),
    revokeChainFrom: vi.fn(async (id: string, at: Date) => {
      let current: string | null = id
      let n = 0
      while (current) {
        const row: RefreshTokenRecord | undefined = [...tokens.values()].find((t) => t.id === current)
        if (!row) break
        row.revokedAt = at
        n += 1
        current = row.replacedById
      }
      return n
    }),
    revokeAllForUser: vi.fn(async (userId: string, at: Date) => {
      let n = 0
      for (const t of tokens.values()) if (t.userId === userId && t.revokedAt === null) { t.revokedAt = at; n += 1 }
      return n
    }),
  }
  function store(t: NewRefreshToken): RefreshTokenRecord {
    nextId += 1
    const record: RefreshTokenRecord = { id: `tok-${nextId}`, userId: t.userId, orgId: t.orgId, expiresAt: t.expiresAt, revokedAt: null, replacedById: null }
    tokens.set(t.tokenHash, record)
    return record
  }

  const users = {
    findByEmail: vi.fn(async (email: string) => ACCOUNTS.find((a) => a.email === email) ?? null),
    findById: vi.fn(async (id: string) => ACCOUNTS.find((a) => a.id === id) ?? null),
    touchLastLogin: vi.fn(async () => undefined),
  }
  const membershipsRepo = {
    findByUser: vi.fn(async (orgId: string, userId: string) => memberships.find((m) => m.orgId === orgId && m.userId === userId) ?? null),
    findById: vi.fn(async () => null),
  }
  const workspaces = {
    listWorkspacesForUser: vi.fn(async () => memberships.map((m) => {
      const org = ORGS.find((o) => o.id === m.orgId) ?? acme
      return { orgId: org.id, slug: org.slug, name: org.slug, role: m.role, status: m.status, orgStatus: org.status }
    })),
  }
  const lookup: OrganizationLookup = {
    byId: async (id) => ORGS.find((o) => o.id === id) ?? null,
    bySlug: async (slug) => ORGS.find((o) => o.slug === slug) ?? null,
    orgIdForTokenPrefix: async () => null,
    retiredSlug: async () => null,
  }
  const passwords = {
    hash: vi.fn(),
    verify: vi.fn(async (stored: string | null, password: string) => stored !== null && password === "correct horse battery staple"),
  }
  const epochs = { bump: vi.fn(async () => undefined), isRevoked: vi.fn(async () => false) }
  const cls = ClsServiceManager.getClsService<RequestContextStore>()
  const service = new SessionService(
    users as unknown as UserRepository,
    refreshTokens as unknown as RefreshTokenRepository,
    membershipsRepo as unknown as MembershipRepository,
    workspaces as unknown as UserOrgIndexRepository,
    lookup,
    passwords as unknown as PasswordService,
    new AccessTokenService(config, clock),
    epochs as unknown as RevocationEpochService,
    new CookieService(config),
    clock,
    config,
  )
  return { service, clock, tokens, refreshTokens, passwords, epochs, users, context: new TenantContextService(cls), membershipsRepo }
}

const client = { userAgent: "vitest", ip: "127.0.0.1" }
const cookieNamed = (cookies: CookieSpec[], name: string) => cookies.find((c) => c.name === name)

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("SessionService.login", () => {
  it("mints pg_id, lists workspaces, and opens the requested workspace", async () => {
    const { service, tokens } = harness()
    const { response, cookies } = await service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    expect(response.user).toEqual({ id: owner.id, email: owner.email, name: "Owner" })
    expect(response.workspaces.map((w) => w.slug)).toEqual(["acme"])
    expect(response.session).toEqual({ slug: "acme" })
    expect(cookies.map((c) => c.name)).toEqual(["pg_id", "pg_at_acme", "pg_rt_acme"])
    expect(cookieNamed(cookies, "pg_rt_acme")?.path).toBe("/api/v1/auth")
    // Secrets are stored hashed, never raw.
    const pgId = cookieNamed(cookies, "pg_id")?.value ?? ""
    expect(tokens.has(hash(pgId))).toBe(true)
    expect(tokens.has(pgId)).toBe(false)
    expect(tokens.get(hash(pgId))?.orgId).toBeNull()
  })

  it("answers one 401 for an unknown address, a wrong password and an unverified account — all after a verification", async () => {
    const { service, passwords } = harness()
    for (const [email, password] of [
      ["nobody@acme.test", "correct horse battery staple"],
      ["owner@acme.test", "wrong"],
      ["new@acme.test", "correct horse battery staple"],
    ] as const) {
      await expect(service.login(email, password, undefined, client)).rejects.toThrow(NotAuthenticatedProblem)
    }
    expect(passwords.verify).toHaveBeenCalledTimes(3)
    expect(passwords.verify).toHaveBeenNthCalledWith(1, null, "correct horse battery staple")
  })

  it("still logs in when the requested workspace cannot be opened, without that pair", async () => {
    const { service } = harness()
    const { response, cookies } = await service.login("owner@acme.test", "correct horse battery staple", "globex", client)
    expect(response.session).toBeNull()
    expect(cookies.map((c) => c.name)).toEqual(["pg_id"])
  })

  it("re-reads the membership inside the tenant, never the projection", async () => {
    const { service, membershipsRepo, context } = harness()
    membershipsRepo.findByUser.mockImplementationOnce(async (orgId: string) => {
      expect(context.current()?.orgId).toBe(orgId)
      return membership(acme.id)
    })
    await service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    expect(membershipsRepo.findByUser).toHaveBeenCalledWith(acme.id, owner.id)
  })
})

describe("SessionService.open", () => {
  it("mints a pair for a workspace the identity belongs to", async () => {
    const { service } = harness()
    const cookies = await service.open(owner.id, "acme", client)
    expect(cookies.map((c) => c.name)).toEqual(["pg_at_acme", "pg_rt_acme"])
  })

  it("is 404 unknown, 403 suspended, 403 not a member, 403 disabled member", async () => {
    const { service } = harness([membership(acme.id), membership(globex.id, "DISABLED")])
    await expect(service.open(owner.id, "nobody", client)).rejects.toThrow(NotFoundProblem)
    await expect(service.open(owner.id, "frozen", client)).rejects.toThrow(OrganizationSuspendedProblem)
    await expect(service.open(owner.id, "globex", client)).rejects.toThrow(NotPermittedProblem)
  })
})

describe("SessionService.refresh", () => {
  async function loggedIn() {
    const h = harness()
    const { cookies } = await h.service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    return { ...h, refresh: cookieNamed(cookies, "pg_rt_acme")?.value ?? "" }
  }

  it("rotates: a new pair, the old token marked replaced", async () => {
    const h = await loggedIn()
    const cookies = await h.service.refresh("acme", h.refresh, client)
    expect(cookies.map((c) => c.name)).toEqual(["pg_at_acme", "pg_rt_acme"])
    expect(h.tokens.get(hash(h.refresh))?.replacedById).toBe("tok-3")
    expect(cookieNamed(cookies, "pg_rt_acme")?.value).not.toBe(h.refresh)
  })

  it("revokes the whole chain when a rotated token is presented again", async () => {
    const h = await loggedIn()
    const rotated = cookieNamed(await h.service.refresh("acme", h.refresh, client), "pg_rt_acme")?.value ?? ""
    await expect(h.service.refresh("acme", h.refresh, client)).rejects.toThrow(NotAuthenticatedProblem)
    expect(h.refreshTokens.revokeChainFrom).toHaveBeenCalledTimes(1)
    // The legitimate holder loses the newest token too — that is the signal.
    await expect(h.service.refresh("acme", rotated, client)).rejects.toThrow(NotAuthenticatedProblem)
  })

  it("refuses an absent, unknown, expired or pg_id token", async () => {
    const h = await loggedIn()
    await expect(h.service.refresh("acme", undefined, client)).rejects.toThrow(NotAuthenticatedProblem)
    await expect(h.service.refresh("acme", "unknown", client)).rejects.toThrow(NotAuthenticatedProblem)
    const pgId = [...h.tokens.entries()].find(([, t]) => t.orgId === null)
    await expect(h.service.refresh("acme", pgId?.[0] ?? "", client)).rejects.toThrow(NotAuthenticatedProblem)
    h.clock.advance(8 * 86_400_000)
    await expect(h.service.refresh("acme", h.refresh, client)).rejects.toThrow(NotAuthenticatedProblem)
  })

  it("is 403 when the cookie's slug and the token's org disagree", async () => {
    const h = await loggedIn()
    await expect(h.service.refresh("globex", h.refresh, client)).rejects.toThrow(TenantMismatchProblem)
  })

  it("revokes the token and refuses when the membership is no longer active", async () => {
    const h = await loggedIn()
    h.membershipsRepo.findByUser.mockResolvedValueOnce(membership(acme.id, "DISABLED"))
    await expect(h.service.refresh("acme", h.refresh, client)).rejects.toThrow(NotAuthenticatedProblem)
    expect(h.tokens.get(hash(h.refresh))?.revokedAt).not.toBeNull()
  })
})

describe("SessionService.logout", () => {
  it("revokes one workspace's refresh token and clears its pair, leaving pg_id alone", async () => {
    const h = harness()
    const { cookies } = await h.service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    const refresh = cookieNamed(cookies, "pg_rt_acme")?.value ?? ""
    const pgId = cookieNamed(cookies, "pg_id")?.value ?? ""
    const clear = await h.service.logout({ slug: "acme", everywhere: false, refreshSecret: refresh, identitySecret: pgId })
    expect(clear.map((c) => c.name)).toEqual(["pg_at_acme", "pg_rt_acme"])
    expect(h.tokens.get(hash(refresh))?.revokedAt).not.toBeNull()
    expect(h.tokens.get(hash(pgId))?.revokedAt).toBeNull()
    expect(await h.service.identityFor(pgId)).toBe(owner.id)
  })

  it("everywhere: revokes every token, bumps every membership's epoch, clears every pair and pg_id", async () => {
    const h = harness([membership(acme.id), membership(globex.id)])
    const { cookies } = await h.service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    const pgId = cookieNamed(cookies, "pg_id")?.value ?? ""
    const clear = await h.service.logout({ slug: undefined, everywhere: true, refreshSecret: undefined, identitySecret: pgId })
    expect([...h.tokens.values()].every((t) => t.revokedAt !== null)).toBe(true)
    expect(h.epochs.bump).toHaveBeenCalledTimes(2)
    expect(clear.map((c) => c.name).sort()).toEqual(["pg_at_acme", "pg_at_globex", "pg_id", "pg_rt_acme", "pg_rt_globex"])
    expect(await h.service.identityFor(pgId)).toBeNull()
  })

  it("is idempotent with nothing presented", async () => {
    const h = harness()
    expect(await h.service.logout({ slug: "acme", everywhere: true, refreshSecret: undefined, identitySecret: undefined })).toEqual([
      { name: "pg_at_acme", path: "/" },
      { name: "pg_rt_acme", path: "/api/v1/auth" },
      { name: "pg_id", path: "/" },
    ])
  })
})
