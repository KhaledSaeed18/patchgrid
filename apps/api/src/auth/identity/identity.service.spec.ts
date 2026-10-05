import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import { NotAuthenticatedProblem, NotPermittedProblem } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import type { AppConfig } from "../../config/app-config"
import type { MailService } from "../../mail/mail.service"
import type { MailJob } from "../../mail/templates"
import type {
  EmailVerificationRepository,
  OneTimeTokenRecord,
  PasswordResetTokenRepository,
} from "../../platform/repositories/one-time-token.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { PasswordService } from "../passwords/password.service"
import { hash, type SessionService } from "../sessions/session.service"
import { IdentityService, RESET_TTL_MINUTES, VERIFICATION_TTL_HOURS } from "./identity.service"

const NOW = new Date("2026-10-05T12:00:00Z")
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const urls = new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], WEB_APP_PORT: 3001, isProduction: false } as AppConfig)

function tokenStore() {
  const rows = new Map<string, OneTimeTokenRecord>()
  let n = 0
  return {
    rows,
    repo: {
      issue: vi.fn(async (userId: string, tokenHash: string, expiresAt: Date, now: Date) => {
        for (const row of rows.values()) if (row.userId === userId && row.usedAt === null) row.usedAt = now
        n += 1
        const record = { id: `t${String(n)}`, userId, expiresAt, usedAt: null }
        rows.set(tokenHash, record)
        return record
      }),
      findByHash: vi.fn(async (h: string) => rows.get(h) ?? null),
      consume: vi.fn(async (id: string, now: Date) => {
        const row = [...rows.values()].find((r) => r.id === id)
        if (!row || row.usedAt !== null) return false
        row.usedAt = now
        return true
      }),
    },
  }
}

function harness(accounts: AccountRecord[] = []) {
  const clock = new FixedClock(NOW)
  const users = {
    findByEmail: vi.fn(async (email: string) => accounts.find((a) => a.email === email) ?? null),
    findById: vi.fn(async (id: string) => accounts.find((a) => a.id === id) ?? null),
    create: vi.fn(async (data: { email: string; name: string; passwordHash: string }) => {
      const account: AccountRecord = { id: `u${String(accounts.length + 1)}`, ...data, emailVerifiedAt: null, anonymisedAt: null }
      accounts.push(account)
      return account
    }),
    markVerified: vi.fn(async (id: string, at: Date) => {
      const a = accounts.find((x) => x.id === id)
      if (a && a.emailVerifiedAt === null) a.emailVerifiedAt = at
    }),
    setPassword: vi.fn(async (id: string, passwordHash: string) => {
      const a = accounts.find((x) => x.id === id)
      if (a) a.passwordHash = passwordHash
    }),
    touchLastLogin: vi.fn(),
  }
  const verifications = tokenStore()
  const resets = tokenStore()
  const passwords = {
    hash: vi.fn(async (p: string) => `hashed:${p}`),
    verify: vi.fn(async (stored: string | null, p: string) => stored === `hashed:${p}`),
  }
  const sent: MailJob[] = []
  const mail = { enqueue: vi.fn(async (job: MailJob) => { sent.push(job) }) }
  const sessions = {
    startIdentity: vi.fn(async (account: AccountRecord) => ({ response: { user: { id: account.id, email: account.email, name: account.name }, workspaces: [], session: null }, cookies: [{ name: "pg_id", value: "x", path: "/", maxAgeSeconds: 1 }] })),
    revokeEverywhere: vi.fn(async () => [{ name: "pg_id", path: "/" }]),
  }
  const service = new IdentityService(
    users as unknown as UserRepository,
    verifications.repo as unknown as EmailVerificationRepository,
    resets.repo as unknown as PasswordResetTokenRepository,
    passwords as unknown as PasswordService,
    mail as unknown as MailService,
    urls,
    sessions as unknown as SessionService,
    clock,
  )
  return { service, clock, users, verifications, resets, passwords, sent, sessions, accounts }
}

const tokenIn = (url: string) => new URL(url).searchParams.get("token") ?? ""
const verified: AccountRecord = { id: "u-v", email: "owner@acme.test", name: "Owner", passwordHash: "hashed:old password here", emailVerifiedAt: NOW, anonymisedAt: null }
const unverified: AccountRecord = { id: "u-n", email: "new@acme.test", name: "New", passwordHash: "hashed:first password", emailVerifiedAt: null, anonymisedAt: null }

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("IdentityService.signup", () => {
  it("creates an unverified account and mails a verification link", async () => {
    const h = harness()
    await h.service.signup("sam@acme.test", "correct horse battery staple", "Sam")
    expect(h.users.create).toHaveBeenCalledWith({ email: "sam@acme.test", name: "Sam", passwordHash: "hashed:correct horse battery staple" })
    expect(h.sent).toHaveLength(1)
    const job = h.sent[0]
    expect(job?.kind).toBe("verify-email")
    if (job?.kind !== "verify-email") throw new Error("unreachable")
    expect(job.to).toBe("sam@acme.test")
    expect(job.params.verifyUrl.startsWith("http://app.lvh.me:3001/verify-email?token=")).toBe(true)
    expect(job.params.expiresInHours).toBe(VERIFICATION_TTL_HOURS)
    // The token in the link is stored only as its hash, expiring in 24 h.
    const record = h.verifications.rows.get(hash(tokenIn(job.params.verifyUrl)))
    expect(record?.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 3_600_000))
  })

  it("mails account-exists for a verified address, without touching the account, at the same cost", async () => {
    const h = harness([{ ...verified }])
    await h.service.signup("owner@acme.test", "another password!!", "Impostor")
    expect(h.passwords.hash).toHaveBeenCalledTimes(1)
    expect(h.users.create).not.toHaveBeenCalled()
    expect(h.users.setPassword).not.toHaveBeenCalled()
    expect(h.sent[0]).toMatchObject({ kind: "account-exists", to: "owner@acme.test", params: { name: "Owner" } })
  })

  it("re-sends the link for an unverified address and keeps the first password", async () => {
    const h = harness([{ ...unverified }])
    await h.service.signup("new@acme.test", "a different password", "New")
    expect(h.sent[0]?.kind).toBe("verify-email")
    expect(h.accounts[0]?.passwordHash).toBe("hashed:first password")
  })
})

describe("IdentityService.verifyEmail", () => {
  async function signedUp() {
    const h = harness()
    await h.service.signup("sam@acme.test", "correct horse battery staple", "Sam")
    const job = h.sent[0]
    if (job?.kind !== "verify-email") throw new Error("unreachable")
    return { ...h, token: tokenIn(job.params.verifyUrl) }
  }

  it("marks the account verified, burns the token and starts the session", async () => {
    const h = await signedUp()
    const result = await h.service.verifyEmail(h.token, client)
    expect(h.accounts[0]?.emailVerifiedAt).toEqual(NOW)
    expect(h.sessions.startIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), client)
    expect(result.cookies.map((c) => c.name)).toEqual(["pg_id"])
  })

  it("refuses a replay, a stranger, and an expired link", async () => {
    const h = await signedUp()
    await h.service.verifyEmail(h.token, client)
    await expect(h.service.verifyEmail(h.token, client)).rejects.toThrow(NotAuthenticatedProblem)
    await expect(h.service.verifyEmail("b".repeat(43), client)).rejects.toThrow(NotAuthenticatedProblem)

    const late = await signedUp()
    late.clock.advance(VERIFICATION_TTL_HOURS * 3_600_000 + 1)
    await expect(late.service.verifyEmail(late.token, client)).rejects.toThrow(NotAuthenticatedProblem)
  })

  it("a re-sent link voids the previous one", async () => {
    const h = await signedUp()
    await h.service.resendVerification("sam@acme.test")
    await expect(h.service.verifyEmail(h.token, client)).rejects.toThrow(NotAuthenticatedProblem)
    const job = h.sent[1]
    if (job?.kind !== "verify-email") throw new Error("unreachable")
    await expect(h.service.verifyEmail(tokenIn(job.params.verifyUrl), client)).resolves.toBeDefined()
  })
})

describe("IdentityService — resend and reset answer the same whatever the address", () => {
  it("resends only for an unverified account", async () => {
    const h = harness([{ ...verified }, { ...unverified }])
    await h.service.resendVerification("nobody@acme.test")
    await h.service.resendVerification("owner@acme.test")
    expect(h.sent).toHaveLength(0)
    await h.service.resendVerification("new@acme.test")
    expect(h.sent[0]?.kind).toBe("verify-email")
  })

  it("mails a reset only for a verified account, with a thirty-minute token", async () => {
    const h = harness([{ ...verified }, { ...unverified }])
    await h.service.requestPasswordReset("nobody@acme.test")
    await h.service.requestPasswordReset("new@acme.test")
    expect(h.sent).toHaveLength(0)
    await h.service.requestPasswordReset("owner@acme.test")
    const job = h.sent[0]
    if (job?.kind !== "reset-password") throw new Error("unreachable")
    expect(job.params.expiresInMinutes).toBe(RESET_TTL_MINUTES)
    expect(h.resets.rows.get(hash(tokenIn(job.params.resetUrl)))?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 60_000))
  })
})

describe("IdentityService.confirmPasswordReset", () => {
  async function requested() {
    const h = harness([{ ...verified }])
    await h.service.requestPasswordReset("owner@acme.test")
    const job = h.sent[0]
    if (job?.kind !== "reset-password") throw new Error("unreachable")
    return { ...h, token: tokenIn(job.params.resetUrl) }
  }

  it("sets the password, burns the token and ends every session", async () => {
    const h = await requested()
    await h.service.confirmPasswordReset(h.token, "a brand new password")
    expect(h.accounts[0]?.passwordHash).toBe("hashed:a brand new password")
    expect(h.sessions.revokeEverywhere).toHaveBeenCalledWith("u-v")
    await expect(h.service.confirmPasswordReset(h.token, "again")).rejects.toThrow(NotAuthenticatedProblem)
  })

  it("refuses an expired link", async () => {
    const h = await requested()
    h.clock.advance(RESET_TTL_MINUTES * 60_000 + 1)
    await expect(h.service.confirmPasswordReset(h.token, "a brand new password")).rejects.toThrow(NotAuthenticatedProblem)
    expect(h.sessions.revokeEverywhere).not.toHaveBeenCalled()
  })
})

describe("IdentityService.changePassword", () => {
  it("re-checks the current password, then sets and revokes everywhere", async () => {
    const h = harness([{ ...verified }])
    await expect(h.service.changePassword("u-v", "wrong", "a brand new password")).rejects.toThrow(NotPermittedProblem)
    expect(h.users.setPassword).not.toHaveBeenCalled()
    const clear = await h.service.changePassword("u-v", "old password here", "a brand new password")
    expect(h.accounts[0]?.passwordHash).toBe("hashed:a brand new password")
    expect(clear).toEqual([{ name: "pg_id", path: "/" }])
  })
})
