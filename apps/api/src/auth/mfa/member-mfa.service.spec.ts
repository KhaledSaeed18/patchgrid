import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem, RateLimitedProblem, ValidationProblem } from "../../common/problems/problem.exception"
import type { AppConfig } from "../../config/app-config"
import type { MailService } from "../../mail/mail.service"
import type { RedisService } from "../../redis/redis.service"
import type { FactorRecord, MfaRepository } from "../../platform/repositories/mfa.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import { CookieService } from "../cookies"
import type { PasswordService } from "../passwords/password.service"
import type { SessionService } from "../sessions/session.service"
import type { FactorLockout } from "./factor-lockout"
import { MemberMfaService } from "./member-mfa.service"
import { MfaChallengeService } from "./mfa-challenge.service"
import { normaliseRecoveryCode } from "./recovery-codes"
import type { PasskeyCeremonies } from "../passkeys/passkey-ceremonies"
import { AccountSecurityNotifier } from "./account-security-notifier"
import { SecretBox } from "./secret-box"
import { codeAt, stepAt } from "./totp"

const KEY = Buffer.alloc(32, 7).toString("base64")
const config = { JWT_SECRET: "local-development-secret-that-is-at-least-32-chars", MFA_ENCRYPTION_KEY: KEY, COOKIE_DOMAIN: ".lvh.me", isProduction: false } as AppConfig
const NOW = new Date("2026-10-16T09:00:00Z")
const client = { userAgent: "vitest", ip: "127.0.0.1" }

const ada: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "ada@acme.test", name: "Ada", passwordHash: "h:correct", emailVerifiedAt: new Date("2026-01-01T00:00:00Z"), anonymisedAt: null }

/** An in-memory `MfaRepository` with the same conditional-update semantics as the real one. */
function harness(options: { secret?: string; pendingSecret?: string; recovery?: string[]; locked?: boolean; passkeys?: number } = {}) {
  const clock = new FixedClock(NOW)
  const box = new SecretBox(KEY)
  const factors: (FactorRecord & { userId: string; createdAt: Date })[] = []
  if (options.secret !== undefined) factors.push({ id: "f-1", userId: ada.id, secretEncrypted: box.seal(options.secret), confirmedAt: new Date("2026-02-01T00:00:00Z"), lastUsedStep: null, createdAt: new Date("2026-02-01T00:00:00Z") })
  if (options.pendingSecret !== undefined) factors.push({ id: "f-2", userId: ada.id, secretEncrypted: box.seal(options.pendingSecret), confirmedAt: null, lastUsedStep: null, createdAt: new Date(NOW.getTime() - 60_000) })
  const recovery = (options.recovery ?? []).map((code, i) => ({ id: `r-${String(i)}`, codeHash: `h:${normaliseRecoveryCode(code)}`, usedAt: null as Date | null }))
  const passkeys = options.passkeys ?? 0
  const mfa = {
    methods: vi.fn(async () => [...(factors.some((f) => f.confirmedAt !== null) ? (["totp"] as const) : []), ...(passkeys > 0 ? (["passkey"] as const) : [])]),
    confirmed: vi.fn(async () => factors.find((f) => f.confirmedAt !== null) ?? null),
    pending: vi.fn(async (_u: string, after: Date) => factors.filter((f) => f.confirmedAt === null && f.createdAt > after).at(-1) ?? null),
    startEnrolment: vi.fn(async (userId: string, secretEncrypted: string) => {
      factors.splice(0, factors.length, ...factors.filter((f) => f.confirmedAt !== null))
      factors.push({ id: "f-new", userId, secretEncrypted, confirmedAt: null, lastUsedStep: null, createdAt: clock.now() })
    }),
    confirm: vi.fn(async (_u: string, id: string, step: number, at: Date, hashes: string[] | null) => {
      const f = factors.find((x) => x.id === id && x.confirmedAt === null)
      if (f === undefined) return { confirmed: false, codesIssued: false }
      Object.assign(f, { confirmedAt: at, lastUsedStep: step })
      if (passkeys > 0 || hashes === null) return { confirmed: true, codesIssued: false }
      recovery.splice(0, recovery.length, ...hashes.map((codeHash, i) => ({ id: `r-${String(i)}`, codeHash, usedAt: null })))
      return { confirmed: true, codesIssued: true }
    }),
    spendStep: vi.fn(async (id: string, step: number) => {
      const f = factors.find((x) => x.id === id)
      if (f === undefined || (f.lastUsedStep !== null && f.lastUsedStep >= step)) return false
      f.lastUsedStep = step
      return true
    }),
    replaceRecoveryCodes: vi.fn(async (_u: string, hashes: string[]) => {
      recovery.splice(0, recovery.length, ...hashes.map((codeHash, i) => ({ id: `r-${String(i)}`, codeHash, usedAt: null })))
    }),
    removeTotp: vi.fn(async () => {
      factors.splice(0)
      if (passkeys === 0) recovery.splice(0)
    }),
    unusedRecoveryCodes: vi.fn(async () => recovery.filter((r) => r.usedAt === null).map(({ id, codeHash }) => ({ id, codeHash }))),
    spendRecoveryCode: vi.fn(async (id: string, at: Date) => {
      const r = recovery.find((x) => x.id === id && x.usedAt === null)
      if (r === undefined) return false
      r.usedAt = at
      return true
    }),
  }
  const failures: string[] = []
  const lockout = {
    assertOpen: vi.fn(async () => {
      if (options.locked === true) throw new RateLimitedProblem(3000)
    }),
    fail: vi.fn(async (userId: string) => {
      failures.push(userId)
      return failures.length === 5
    }),
    clear: vi.fn(async () => undefined),
  }
  type SecurityMail = { to: string; orgId: string | null; params: { event: string; remaining: number } }
  const mail = { enqueue: vi.fn<(job: SecurityMail, key: string) => Promise<void>>(async () => undefined) }
  const sessions = {
    startIdentity: vi.fn(async (account: AccountRecord, _c: unknown, slug?: string) => ({
      response: { status: "signed-in" as const, user: { id: account.id, email: account.email, name: account.name }, workspaces: [], session: slug === undefined ? null : { slug } },
      cookies: [{ name: "pg_id", value: "x", path: "/", maxAgeSeconds: 1 }],
    })),
    revokeEverywhere: vi.fn(async () => []),
  }
  const passwords = { hash: vi.fn(async (plain: string) => `h:${plain}`), verify: vi.fn(async (stored: string | null, plain: string) => stored === `h:${plain}`) }
  const challenges = new MfaChallengeService(config, clock)
  // A passkey proof verifies when its challenge id says so; the ceremonies have their own spec.
  const ceremonies = { verifyAssertion: vi.fn(async (_p: string, challengeId: string, _c: unknown, userId: string) => (challengeId === "good" ? { userId, passkeyId: "pk-1" } : null)) }
  const spent = new Set<string>()
  const redis = { client: { set: vi.fn(async (key: string) => (spent.has(key) ? null : (spent.add(key), "OK"))) } }
  const service = new MemberMfaService(
    { findById: async (id: string) => (id === ada.id ? ada : null) } as unknown as UserRepository,
    mfa as unknown as MfaRepository,
    passwords as unknown as PasswordService,
    lockout as unknown as FactorLockout,
    challenges,
    ceremonies as unknown as PasskeyCeremonies,
    sessions as unknown as SessionService,
    new CookieService(config),
    new AccountSecurityNotifier({ findById: async (id: string) => (id === ada.id ? ada : null) } as unknown as UserRepository, mail as unknown as MailService, clock),
    redis as unknown as RedisService,
    config,
    clock,
  )
  const sent = () => mail.enqueue.mock.calls.map(([job]) => job.params.event)
  return { service, clock, challenges, ceremonies, mfa, lockout, sessions, mail, sent, factors, recovery, failures, box }
}

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("MemberMfaService.completeLogin", () => {
  it("turns a challenge plus a current code into the session the password alone could not start, with the workspace it asked for", async () => {
    const h = harness({ secret: SECRET })
    const token = await h.challenges.issue(ada.id, "acme")
    const result = await h.service.completeLogin(token, { code: codeAt(SECRET, NOW) }, client)
    expect(result.response).toMatchObject({ status: "signed-in", session: { slug: "acme" } })
    expect(result.clear).toEqual([{ name: "pg_mc", path: "/api/v1/auth" }])
    expect(h.sessions.startIdentity).toHaveBeenCalledWith(ada, client, "acme")
  })

  it("refuses a missing, forged or expired challenge with a 401, before any code is looked at", async () => {
    const h = harness({ secret: SECRET })
    await expect(h.service.completeLogin(undefined, { code: "000000" }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    await expect(h.service.completeLogin("not.a.jwt", { code: "000000" }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    const token = await h.challenges.issue(ada.id, undefined)
    h.clock.set(new Date(NOW.getTime() + 6 * 60_000))
    await expect(h.service.completeLogin(token, { code: codeAt(SECRET, h.clock.now()) }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    expect(h.lockout.assertOpen).not.toHaveBeenCalled()
  })

  it("completes a challenge once: the same cookie replayed with a fresh code earns no second session", async () => {
    const h = harness({ secret: SECRET })
    const token = await h.challenges.issue(ada.id, undefined)
    await h.service.completeLogin(token, { code: codeAt(SECRET, NOW) }, client)
    h.clock.set(new Date(NOW.getTime() + 31_000))
    await expect(h.service.completeLogin(token, { code: codeAt(SECRET, h.clock.now()) }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    expect(h.sessions.startIdentity).toHaveBeenCalledTimes(1)
  })

  it("never accepts a code twice, even inside its thirty-second window", async () => {
    const h = harness({ secret: SECRET })
    const code = codeAt(SECRET, NOW)
    await h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { code }, client)
    await expect(h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { code }, client)).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.failures).toHaveLength(1)
  })

  it("signs in with one unused recovery code once, ends every other session, and says so by mail", async () => {
    const h = harness({ secret: SECRET, recovery: ["abcde-fghij", "klmnp-qrstu"] })
    const first = await h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { recoveryCode: "ABCDE FGHIJ" }, client)
    expect(first.response.status).toBe("signed-in")
    expect(h.sessions.revokeEverywhere).toHaveBeenCalledWith(ada.id, { before: true })
    expect(h.sent()).toEqual(["recovery-code-used"])
    expect(h.mail.enqueue.mock.calls[0]?.[0]).toMatchObject({ to: ada.email, orgId: null, params: { remaining: 1 } })
    await expect(h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { recoveryCode: "abcde-fghij" }, client)).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("locks the factor on the fifth wrong proof and tells the person; a locked factor refuses even a good code", async () => {
    const h = harness({ secret: SECRET })
    for (let i = 0; i < 5; i += 1) {
      await expect(h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { code: "000000" }, client)).rejects.toBeInstanceOf(ValidationProblem)
    }
    expect(h.sent()).toEqual(["factor-locked"])
    const locked = harness({ secret: SECRET, locked: true })
    await expect(locked.service.completeLogin(await locked.challenges.issue(ada.id, undefined), { code: codeAt(SECRET, NOW) }, client)).rejects.toBeInstanceOf(RateLimitedProblem)
    expect(locked.mfa.spendStep).not.toHaveBeenCalled()
  })
})

describe("MemberMfaService self-service", () => {
  it("enrols, refuses a wrong code, then confirms with the right one and shows ten recovery codes once", async () => {
    const h = harness()
    expect(await h.service.status(ada.id)).toEqual({ enrolled: false, confirmedAt: null, methods: [], password: true, recoveryCodesRemaining: 0 })
    // The password first: a pg_id alone does not get to set the factor.
    await expect(h.service.enrol(ada.id, { password: "wrong" })).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.lockout.fail).toHaveBeenCalledWith(ada.id)
    const enrolment = await h.service.enrol(ada.id, { password: "correct" })
    expect(enrolment.otpauthUri).toContain(`otpauth://totp/Patchgrid:${encodeURIComponent(ada.email)}`)
    expect(h.factors[0]?.secretEncrypted).not.toContain(enrolment.secret)
    await expect(h.service.confirm(ada.id, "000000")).rejects.toBeInstanceOf(ValidationProblem)
    const { recoveryCodes } = await h.service.confirm(ada.id, codeAt(enrolment.secret, NOW))
    expect(recoveryCodes).toHaveLength(10)
    expect(new Set(recoveryCodes).size).toBe(10)
    expect(await h.service.status(ada.id)).toMatchObject({ enrolled: true, methods: ["totp"], recoveryCodesRemaining: 10 })
    expect(h.sent()).toEqual(["factor-enabled"])
    // The confirming code is spent: it does not also sign in.
    expect(h.factors.find((f) => f.id === "f-new")?.lastUsedStep).toBe(stepAt(NOW))
  })

  it("refuses to enrol while a factor is confirmed, and an unconfirmed factor older than an hour", async () => {
    const h = harness({ secret: SECRET })
    await expect(h.service.enrol(ada.id, { password: "correct" })).rejects.toBeInstanceOf(ConflictProblem)
    const stale = harness({ pendingSecret: SECRET })
    stale.clock.set(new Date(NOW.getTime() + 61 * 60_000))
    await expect(stale.service.confirm(ada.id, codeAt(SECRET, stale.clock.now()))).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("replaces the recovery codes only against a current code, and says so", async () => {
    const h = harness({ secret: SECRET, recovery: ["abcde-fghij"] })
    await expect(h.service.regenerateRecoveryCodes(ada.id, { code: "000000" })).rejects.toBeInstanceOf(ValidationProblem)
    const { recoveryCodes } = await h.service.regenerateRecoveryCodes(ada.id, { code: codeAt(SECRET, NOW) })
    expect(recoveryCodes).toHaveLength(10)
    expect(h.recovery.map((r) => r.codeHash)).not.toContain("h:abcdefghij")
    expect(h.sent()).toEqual(["recovery-codes-regenerated"])
  })

  it("turns the factor off against the factor itself or a recovery code, never silently", async () => {
    const h = harness({ secret: SECRET, recovery: ["abcde-fghij"] })
    await expect(h.service.disable(ada.id, { code: "000000" })).rejects.toBeInstanceOf(ValidationProblem)
    await h.service.disable(ada.id, { recoveryCode: "abcde-fghij" })
    expect(h.factors).toHaveLength(0)
    expect(h.recovery).toHaveLength(0)
    expect(h.sent()).toEqual(["recovery-code-used", "factor-disabled"])
    await expect(h.service.disable(ada.id, { code: "000000" })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("stands whether or not the mail goes", async () => {
    const h = harness({ secret: SECRET })
    h.mail.enqueue.mockRejectedValueOnce(new Error("redis down"))
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
    await h.service.disable(ada.id, { code: codeAt(SECRET, NOW) })
    expect(h.factors).toHaveLength(0)
  })
})

const passkey = (challengeId: string) => ({ challengeId, credential: { id: "x", rawId: "x", type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" } } })

describe("MemberMfaService with passkeys (ADR-0053)", () => {
  it("completes the second step with a passkey asserted for this person, and refuses one that is not, without counting it", async () => {
    const h = harness({ passkeys: 1 })
    const result = await h.service.completeLogin(await h.challenges.issue(ada.id, "acme"), { passkey: passkey("good") }, client)
    expect(result.response).toMatchObject({ status: "signed-in", session: { slug: "acme" } })
    expect(h.ceremonies.verifyAssertion).toHaveBeenCalledWith("proof", "good", expect.anything(), ada.id)
    await expect(h.service.completeLogin(await h.challenges.issue(ada.id, undefined), { passkey: passkey("bad") }, client)).rejects.toBeInstanceOf(ValidationProblem)
    // A passkey is not guessable: a refused one is not a guess against the lockout.
    expect(h.lockout.fail).not.toHaveBeenCalled()
  })

  it("takes the password as the holder's proof only when they hold no factor at all", async () => {
    const none = harness()
    expect(await none.service.proveHolder(ada.id, { password: "correct" })).toBe("password")
    await expect(none.service.proveHolder(ada.id, { code: "123456" })).rejects.toBeInstanceOf(ValidationProblem)

    const held = harness({ passkeys: 1 })
    await expect(held.service.proveHolder(ada.id, { password: "correct" })).rejects.toMatchObject({ errors: [{ code: "factor_required" }] })
    expect(await held.service.proveHolder(ada.id, { passkey: passkey("good") })).toBe("passkey")
  })

  it("refuses to set up the authenticator app beside a passkey on the password alone", async () => {
    const h = harness({ passkeys: 1, recovery: ["abcde-fghij"] })
    await expect(h.service.enrol(ada.id, { password: "correct" })).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.mfa.startEnrolment).not.toHaveBeenCalled()
    await h.service.enrol(ada.id, { passkey: passkey("good") })
    expect(h.mfa.startEnrolment).toHaveBeenCalled()
  })

  it("keeps the person's recovery codes when the authenticator app is their second factor, not their first", async () => {
    const h = harness({ passkeys: 1, recovery: ["abcde-fghij"] })
    const enrolment = await h.service.enrol(ada.id, { passkey: passkey("good") })
    const added = await h.service.confirm(ada.id, codeAt(enrolment.secret, NOW))
    expect(added.recoveryCodes).toBeNull()
    expect(h.mfa.confirm).toHaveBeenCalledWith(ada.id, "f-new", expect.any(Number), NOW, null, "if-first")
    expect(h.recovery).toHaveLength(1)
    expect(await h.service.status(ada.id)).toMatchObject({ enrolled: true, methods: ["totp", "passkey"], recoveryCodesRemaining: 1 })
  })

  it("turns the authenticator app off with a passkey, and the codes stay while a passkey remains", async () => {
    const h = harness({ secret: SECRET, passkeys: 1, recovery: ["abcde-fghij"] })
    await h.service.disable(ada.id, { passkey: passkey("good") })
    expect(h.factors).toHaveLength(0)
    expect(h.recovery).toHaveLength(1)
    expect(await h.service.status(ada.id)).toEqual({ enrolled: false, confirmedAt: null, methods: ["passkey"], password: true, recoveryCodesRemaining: 1 })
  })

  it("replaces the recovery codes against a passkey for someone who holds no authenticator app", async () => {
    const h = harness({ passkeys: 1, recovery: ["abcde-fghij"] })
    const { recoveryCodes } = await h.service.regenerateRecoveryCodes(ada.id, { passkey: passkey("good") })
    expect(recoveryCodes).toHaveLength(10)
    await expect(h.service.regenerateRecoveryCodes(ada.id, { passkey: passkey("bad") })).rejects.toBeInstanceOf(ValidationProblem)
  })
})
