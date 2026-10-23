import { Logger } from "@nestjs/common"
import type { LoginResponse, SignedInResponse } from "@patchgrid/contracts"
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
import { MfaRequiredProblem, SsoRequiredProblem, SsoSessionScopedProblem } from "../../common/problems/problem.exception"
import type { PasswordService } from "../passwords/password.service"
import type { RevocationEpochService } from "../revocation/revocation-epoch.service"
import type { MfaRepository } from "../../platform/repositories/mfa.repository"
import { MfaChallengeService } from "../mfa/mfa-challenge.service"
import { AccessTokenService } from "../tokens/access-token.service"
import { hash, SessionService } from "./session.service"

const config = {
  JWT_SECRET: "local-development-secret-that-is-at-least-32-chars",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 7,
  COOKIE_DOMAIN: ".lvh.me",
  isProduction: false,
} as AppConfig

const acme: OrganizationSummary = { id: "0190b2f0-0000-7000-8000-00000000000a", slug: "acme", status: "ACTIVE", plan: "FREE", agentVisibility: "ALL_TICKETS", requireMfa: false, requireSso: false }
const globex: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000b", slug: "globex" }
const frozen: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000f", slug: "frozen", status: "SUSPENDED" }
/** Requires a second factor of every member (ADR-0045). */
const strict: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000c", slug: "strict", requireMfa: true }
/** Requires SSO of every member but its owners (ADR-0054), and a second factor of password sessions. */
const sso: OrganizationSummary = { ...acme, id: "0190b2f0-0000-7000-8000-00000000000d", slug: "sso", requireSso: true, requireMfa: true }
const ORGS = [acme, globex, frozen, strict, sso]

const owner: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "owner@acme.test", name: "Owner", passwordHash: "$argon2id$owner", emailVerifiedAt: new Date("2026-01-01T00:00:00Z"), anonymisedAt: null }
const unverified: AccountRecord = { ...owner, id: "0190b2f0-0000-7000-8000-000000000002", email: "new@acme.test", passwordHash: "$argon2id$new", emailVerifiedAt: null }
const ACCOUNTS = [owner, unverified]

const membership = (orgId: string, status: MembershipRecord["status"] = "ACTIVE", role: MembershipRecord["role"] = "OWNER"): MembershipRecord => ({
  id: `0190b2f0-0000-7000-8000-00000000${orgId.slice(-2)}aa`,
  orgId,
  userId: owner.id,
  role,
  status,
  kind: "HUMAN",
  displayName: "Owner",
  teamIds: [],
  leadOfTeamIds: [],
})

function harness(memberships: MembershipRecord[] = [membership(acme.id)], options: { enrolled?: string[] } = {}) {
  const clock = new FixedClock(new Date("2026-10-05T12:00:00Z"))
  const enrolled = new Set(options.enrolled ?? [])
  const mfa = { methods: vi.fn(async (userId: string) => (enrolled.has(userId) ? (["totp"] as const) : [])) }
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
    const record: RefreshTokenRecord = { id: `tok-${nextId}`, userId: t.userId, orgId: t.orgId, expiresAt: t.expiresAt, revokedAt: null, replacedById: null, ssoOrgId: t.ssoOrgId }
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
    mfa as unknown as MfaRepository,
    new MfaChallengeService(config, clock),
    clock,
    config,
  )
  return { service, clock, tokens, refreshTokens, passwords, epochs, users, context: new TenantContextService(cls), membershipsRepo, enrolled }
}

const client = { userAgent: "vitest", ip: "127.0.0.1" }
/** The login answer when it is a session, as every existing case expects. */
function signedIn(response: LoginResponse): SignedInResponse {
  if (response.status !== "signed-in") throw new Error(`expected a session, got ${response.status}`)
  return response
}
const cookieNamed = (cookies: CookieSpec[], name: string) => cookies.find((c) => c.name === name)

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("SessionService.login", () => {
  it("mints pg_id, lists workspaces, and opens the requested workspace", async () => {
    const { service, tokens } = harness()
    const { response: answered, cookies } = await service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    const response = signedIn(answered)
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
    expect(signedIn(response).session).toBeNull()
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

describe("SessionService with a second factor (ADR-0045)", () => {
  it("answers the right password with a challenge, not a session, when a factor is confirmed", async () => {
    const { service, tokens } = harness([membership(acme.id)], { enrolled: [owner.id] })
    const { response, cookies } = await service.login("owner@acme.test", "correct horse battery staple", "acme", client)
    expect(response).toEqual({ status: "mfa-required", methods: ["totp"] })
    expect(cookies.map((c) => [c.name, c.path, c.maxAgeSeconds])).toEqual([["pg_mc", "/api/v1/auth", 300]])
    // Nothing was issued: no identity, no pair.
    expect(tokens.size).toBe(0)
  })

  it("still answers one 401 for a wrong password, factor or not", async () => {
    const { service } = harness([membership(acme.id)], { enrolled: [owner.id] })
    await expect(service.login("owner@acme.test", "wrong", "acme", client)).rejects.toThrow(NotAuthenticatedProblem)
  })

  it("tells the picker whether a factor exists", async () => {
    const without = harness()
    expect((await without.service.identity({ userId: owner.id, ssoOrgId: null })).mfa).toEqual({ enrolled: false })
    const withFactor = harness([membership(acme.id)], { enrolled: [owner.id] })
    expect((await withFactor.service.identity({ userId: owner.id, ssoOrgId: null })).mfa).toEqual({ enrolled: true })
  })

  it("opens a workspace that requires a factor only for someone who has one — at login, open and refresh", async () => {
    const without = harness([membership(strict.id)])
    const login = await without.service.login("owner@acme.test", "correct horse battery staple", "strict", client)
    expect(signedIn(login.response).session).toBeNull()
    await expect(without.service.open(owner.id, "strict", client)).rejects.toThrow(MfaRequiredProblem)

    const enrolled = harness([membership(strict.id)], { enrolled: [owner.id] })
    const cookies = await enrolled.service.open(owner.id, "strict", client)
    expect(cookies.map((c) => c.name)).toEqual(["pg_at_strict", "pg_rt_strict"])
    // The factor goes away (turned off): the next refresh is where the policy bites, not the open session.
    enrolled.enrolled.delete(owner.id)
    await expect(enrolled.service.refresh("strict", cookieNamed(cookies, "pg_rt_strict")?.value ?? "", client)).rejects.toThrow(MfaRequiredProblem)
    // The refresh token itself was not revoked: enrolling again makes it good.
    enrolled.enrolled.add(owner.id)
    expect((await enrolled.service.refresh("strict", cookieNamed(cookies, "pg_rt_strict")?.value ?? "", client)).map((c) => c.name)).toEqual(["pg_at_strict", "pg_rt_strict"])
  })

  it("stamps a pair opened after a step-up with when it was proved, and nothing else carries the claim", async () => {
    const { service, clock } = harness()
    const proved = await service.open(owner.id, "acme", client, { stepUpAt: clock.now() })
    const plain = await service.open(owner.id, "acme", client)
    const access = new AccessTokenService(config, clock)
    expect((await access.verify(cookieNamed(proved, "pg_at_acme")?.value ?? ""))?.sua).toBe(Math.floor(clock.now().getTime() / 1000))
    expect((await access.verify(cookieNamed(plain, "pg_at_acme")?.value ?? ""))?.sua).toBeUndefined()
    const refreshed = await service.refresh("acme", cookieNamed(proved, "pg_rt_acme")?.value ?? "", client)
    expect((await access.verify(cookieNamed(refreshed, "pg_at_acme")?.value ?? ""))?.sua).toBeUndefined()
  })
})

describe("SSO sessions (ADR-0054)", () => {
  const read = async (cookies: CookieSpec[], name: string) =>
    new AccessTokenService(config, new FixedClock(new Date("2026-10-05T12:00:00Z"))).verify(cookieNamed(cookies, name)?.value ?? "")

  it("opens only the workspace whose identity provider started it", async () => {
    const h = harness([membership(acme.id), membership(globex.id)])
    const { cookies, response } = await h.service.startIdentity(owner, client, "acme", acme.id)
    expect(response.session).toEqual({ slug: "acme" })
    expect((await read(cookies, "pg_at_acme"))?.sso).toBe(true)
    const identity = await h.service.identityFor(cookieNamed(cookies, "pg_id")?.value)
    expect(identity).toEqual({ userId: owner.id, ssoOrgId: acme.id })
    await expect(h.service.open(owner.id, "globex", client, { ssoOrgId: acme.id })).rejects.toThrow(SsoSessionScopedProblem)
    expect((await h.service.open(owner.id, "acme", client, { ssoOrgId: acme.id })).map((c) => c.name)).toEqual(["pg_at_acme", "pg_rt_acme"])
  })

  it("never lets a refresh launder the scope", async () => {
    const h = harness([membership(acme.id)])
    const opened = await h.service.open(owner.id, "acme", client, { ssoOrgId: acme.id })
    const refreshed = await h.service.refresh("acme", cookieNamed(opened, "pg_rt_acme")?.value ?? "", client)
    expect((await read(refreshed, "pg_at_acme"))?.sso).toBe(true)
    expect([...h.tokens.values()].every((t) => t.ssoOrgId === acme.id)).toBe(true)
  })

  it("an ordinary session carries no sso claim", async () => {
    const h = harness()
    expect((await read(await h.service.open(owner.id, "acme", client), "pg_at_acme"))?.sso).toBeUndefined()
  })

  it("requires SSO of a non-owner at open, login and refresh, and spares the owner", async () => {
    const agent = harness([membership(sso.id, "ACTIVE", "AGENT")], { enrolled: [owner.id] })
    await expect(agent.service.open(owner.id, "sso", client)).rejects.toThrow(SsoRequiredProblem)
    const login = await agent.service.login("owner@acme.test", "correct horse battery staple", "sso", client)
    expect(login.response.status).toBe("mfa-required")
    expect((await agent.service.open(owner.id, "sso", client, { ssoOrgId: sso.id })).map((c) => c.name)).toEqual(["pg_at_sso", "pg_rt_sso"])

    // The owner is the way back in when the identity provider is down: their own credentials still open it.
    const theOwner = harness([membership(sso.id)], { enrolled: [owner.id] })
    expect((await theOwner.service.open(owner.id, "sso", client)).map((c) => c.name)).toEqual(["pg_at_sso", "pg_rt_sso"])
  })

  it("gates a password session's next refresh once SSO is required, never the session already open", async () => {
    const h = harness([membership(acme.id, "ACTIVE", "AGENT")])
    const opened = await h.service.open(owner.id, "acme", client)
    const required: OrganizationSummary = { ...acme, requireSso: true }
    ORGS.splice(0, 1, required)
    try {
      await expect(h.service.refresh("acme", cookieNamed(opened, "pg_rt_acme")?.value ?? "", client)).rejects.toThrow(SsoRequiredProblem)
    } finally {
      ORGS.splice(0, 1, acme)
    }
  })

  it("lets this workspace's own identity provider stand in for its factor requirement, and no other", async () => {
    const h = harness([membership(sso.id, "ACTIVE", "AGENT"), membership(strict.id, "ACTIVE", "AGENT")])
    expect((await h.service.open(owner.id, "sso", client, { ssoOrgId: sso.id })).map((c) => c.name)).toEqual(["pg_at_sso", "pg_rt_sso"])
    await expect(h.service.open(owner.id, "strict", client)).rejects.toThrow(MfaRequiredProblem)
    await expect(h.service.open(owner.id, "strict", client, { ssoOrgId: sso.id })).rejects.toThrow(SsoSessionScopedProblem)
  })

  it("tells the picker which workspace an SSO session belongs to", async () => {
    const h = harness([membership(acme.id)])
    expect((await h.service.identity({ userId: owner.id, ssoOrgId: acme.id })).sso).toEqual({ slug: "acme" })
    expect((await h.service.identity({ userId: owner.id, ssoOrgId: null })).sso).toBeNull()
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
    expect(await h.service.identityFor(pgId)).toEqual({ userId: owner.id, ssoOrgId: null })
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
