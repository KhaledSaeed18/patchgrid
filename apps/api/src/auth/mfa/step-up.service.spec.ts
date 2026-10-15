import { STEP_UP_TTL_SECONDS } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import { StepUpRequiredProblem, ValidationProblem } from "../../common/problems/problem.exception"
import type { MfaRepository } from "../../platform/repositories/mfa.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { MemberActor, TenantActor } from "../actor"
import type { PasswordService } from "../passwords/password.service"
import type { SessionService } from "../sessions/session.service"
import type { FactorLockout } from "./factor-lockout"
import type { MemberMfaService } from "./member-mfa.service"
import { StepUpService } from "./step-up.service"

const NOW = new Date("2026-10-16T09:00:00Z")
const nowSeconds = Math.floor(NOW.getTime() / 1000)
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const ada: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "ada@acme.test", name: "Ada", passwordHash: "h:correct", emailVerifiedAt: new Date(0), anonymisedAt: null }

function harness(enrolled: boolean) {
  const factors = { verify: vi.fn(async () => "totp" as const), refused: vi.fn(async () => new ValidationProblem([{ path: "code", message: "is not a valid code", code: "invalid_code" }])) }
  const sessions = { open: vi.fn(async (_u: string, slug: string) => [{ name: `pg_at_${slug}`, value: "t", path: "/", maxAgeSeconds: 900 }]) }
  const lockout = { assertOpen: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) }
  const service = new StepUpService(
    { findById: async () => ada } as unknown as UserRepository,
    { confirmed: async () => (enrolled ? { id: "f" } : null) } as unknown as MfaRepository,
    { verify: async (stored: string | null, plain: string) => stored === `h:${plain}` } as unknown as PasswordService,
    lockout as unknown as FactorLockout,
    factors as unknown as MemberMfaService,
    sessions as unknown as SessionService,
    new FixedClock(NOW),
  )
  return { service, factors, sessions, lockout }
}

const member = (stepUpAt?: number): MemberActor => ({ kind: "member", userId: ada.id, orgId: "o-1", membershipId: "m-1", role: "OWNER", teamIds: [], leadOfTeamIds: [], ...(stepUpAt === undefined ? {} : { stepUpAt }) })

describe("StepUpService.assert", () => {
  it("passes a member proved within the window and refuses one proved earlier, later, or never", () => {
    const { service } = harness(true)
    expect(() => service.assert(member(nowSeconds))).not.toThrow()
    expect(() => service.assert(member(nowSeconds - STEP_UP_TTL_SECONDS))).not.toThrow()
    expect(() => service.assert(member(nowSeconds - STEP_UP_TTL_SECONDS - 1))).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(member(nowSeconds + 60))).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(member())).toThrow(StepUpRequiredProblem)
  })

  it("has no answer for a service account or a support session: neither can re-prove a person", () => {
    const { service } = harness(true)
    const token: TenantActor = { kind: "service", orgId: "o-1", membershipId: "m-svc", role: "ADMIN", scopes: [], tokenId: "t" }
    const support: TenantActor = { kind: "support", orgId: "o-1", sessionId: "s", platformAdminId: "p", userId: "u", role: "ADMIN", membershipId: "s" }
    expect(() => service.assert(token)).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(support)).toThrow(StepUpRequiredProblem)
  })
})

describe("StepUpService.prove", () => {
  it("with a factor enrolled, takes the factor and re-issues the workspace's pair stamped with now", async () => {
    const h = harness(true)
    const result = await h.service.prove(ada.id, { slug: "acme", code: "123456" }, client)
    expect(h.factors.verify).toHaveBeenCalledWith(ada.id, { code: "123456" })
    expect(h.sessions.open).toHaveBeenCalledWith(ada.id, "acme", client, { stepUpAt: NOW })
    expect(result.response.stepUpExpiresAt).toBe(new Date(NOW.getTime() + STEP_UP_TTL_SECONDS * 1000).toISOString())
    expect(result.cookies.map((c) => c.name)).toEqual(["pg_at_acme"])
  })

  it("with a factor enrolled, refuses the password: it can never stand in for the factor", async () => {
    const h = harness(true)
    await expect(h.service.prove(ada.id, { slug: "acme", password: "correct" }, client)).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.sessions.open).not.toHaveBeenCalled()
  })

  it("without a factor, takes the password — counted against the same lockout as a code would be", async () => {
    const h = harness(false)
    await expect(h.service.prove(ada.id, { slug: "acme", code: "123456" }, client)).rejects.toBeInstanceOf(ValidationProblem)
    await expect(h.service.prove(ada.id, { slug: "acme", password: "wrong" }, client)).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.factors.refused).toHaveBeenCalledWith(ada.id)
    await h.service.prove(ada.id, { slug: "acme", password: "correct" }, client)
    expect(h.lockout.clear).toHaveBeenCalledWith(ada.id)
    expect(h.sessions.open).toHaveBeenCalledTimes(1)
  })
})
