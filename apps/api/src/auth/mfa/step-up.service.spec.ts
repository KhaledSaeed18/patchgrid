import { STEP_UP_TTL_SECONDS } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import { SsoSessionScopedProblem, StepUpRequiredProblem, ValidationProblem } from "../../common/problems/problem.exception"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { MemberActor, TenantActor } from "../actor"
import type { SessionService } from "../sessions/session.service"
import type { MemberMfaService } from "./member-mfa.service"
import { StepUpService } from "./step-up.service"

const NOW = new Date("2026-10-16T09:00:00Z")
const nowSeconds = Math.floor(NOW.getTime() / 1000)
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const ada: AccountRecord = {
  id: "0190b2f0-0000-7000-8000-000000000001",
  email: "ada@acme.test",
  name: "Ada",
  passwordHash: "h:correct",
  emailVerifiedAt: new Date(0),
  anonymisedAt: null,
}

function harness() {
  const factors = {
    proveHolder: vi.fn(async (_u: string, proof: { password?: string }) => {
      if (proof.password === "wrong")
        throw new ValidationProblem([{ path: "password", message: "does not match", code: "invalid_password" }])
      return "totp" as const
    }),
  }
  const sessions = {
    open: vi.fn(async (_u: string, slug: string) => [{ name: `pg_at_${slug}`, value: "t", path: "/", maxAgeSeconds: 900 }]),
  }
  const service = new StepUpService(
    { findById: async () => ada } as unknown as UserRepository,
    factors as unknown as MemberMfaService,
    sessions as unknown as SessionService,
    new FixedClock(NOW),
  )
  return { service, factors, sessions }
}

const member = (stepUpAt?: number): MemberActor => ({
  kind: "member",
  userId: ada.id,
  orgId: "o-1",
  membershipId: "m-1",
  role: "OWNER",
  teamIds: [],
  leadOfTeamIds: [],
  ...(stepUpAt === undefined ? {} : { stepUpAt }),
})

describe("StepUpService.assert", () => {
  it("passes a member proved within the window and refuses one proved earlier, later, or never", () => {
    const { service } = harness()
    expect(() => service.assert(member(nowSeconds))).not.toThrow()
    expect(() => service.assert(member(nowSeconds - STEP_UP_TTL_SECONDS))).not.toThrow()
    expect(() => service.assert(member(nowSeconds - STEP_UP_TTL_SECONDS - 1))).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(member(nowSeconds + 60))).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(member())).toThrow(StepUpRequiredProblem)
  })

  it("has no answer for a service account or a support session: neither can re-prove a person", () => {
    const { service } = harness()
    const token: TenantActor = { kind: "service", orgId: "o-1", membershipId: "m-svc", role: "ADMIN", scopes: [], tokenId: "t" }
    const support: TenantActor = {
      kind: "support",
      orgId: "o-1",
      sessionId: "s",
      platformAdminId: "p",
      userId: "u",
      role: "ADMIN",
      membershipId: "s",
    }
    expect(() => service.assert(token)).toThrow(StepUpRequiredProblem)
    expect(() => service.assert(support)).toThrow(StepUpRequiredProblem)
  })
})

describe("StepUpService.prove", () => {
  it("proves the holder by the step-up rule and re-issues the workspace's pair stamped with now", async () => {
    const h = harness()
    const result = await h.service.prove({ userId: ada.id, ssoOrgId: null }, { slug: "acme", code: "123456" }, client)
    // The slug names the cookie; it is not part of the proof.
    expect(h.factors.proveHolder).toHaveBeenCalledWith(ada.id, { code: "123456" })
    expect(h.sessions.open).toHaveBeenCalledWith(ada.id, "acme", client, { stepUpAt: NOW, ssoOrgId: null })
    expect(result.response.stepUpExpiresAt).toBe(new Date(NOW.getTime() + STEP_UP_TTL_SECONDS * 1000).toISOString())
    expect(result.cookies.map((c) => c.name)).toEqual(["pg_at_acme"])
  })

  it("sends an SSO session to its provider: the person's own factors are not the provider's to try", async () => {
    const h = harness()
    await expect(h.service.prove({ userId: ada.id, ssoOrgId: "o-acme" }, { slug: "acme", code: "123456" }, client)).rejects.toBeInstanceOf(
      SsoSessionScopedProblem,
    )
    expect(h.factors.proveHolder).not.toHaveBeenCalled()
  })

  it("opens nothing when the proof is refused", async () => {
    const h = harness()
    await expect(h.service.prove({ userId: ada.id, ssoOrgId: null }, { slug: "acme", password: "wrong" }, client)).rejects.toBeInstanceOf(
      ValidationProblem,
    )
    expect(h.sessions.open).not.toHaveBeenCalled()
  })
})
