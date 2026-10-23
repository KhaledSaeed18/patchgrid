import { Logger } from "@nestjs/common"
import type { PasskeyRegisterRequest } from "@patchgrid/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ConflictProblem, NotAuthenticatedProblem, NotFoundProblem, ValidationProblem } from "../../common/problems/problem.exception"
import type { MfaRepository } from "../../platform/repositories/mfa.repository"
import type { NewPasskey, PasskeyRecord, PasskeyRepository } from "../../platform/repositories/passkey.repository"
import type { AccountRecord, UserRepository } from "../../platform/repositories/user.repository"
import type { AccountSecurityNotifier } from "../mfa/account-security-notifier"
import type { MemberMfaService } from "../mfa/member-mfa.service"
import type { MfaChallengeService } from "../mfa/mfa-challenge.service"
import type { PasswordService } from "../passwords/password.service"
import type { SessionService } from "../sessions/session.service"
import type { PasskeyCeremonies } from "./passkey-ceremonies"
import { PasskeyService } from "./passkey.service"

const client = { userAgent: "vitest", ip: "127.0.0.1" }
const ada: AccountRecord = { id: "0190b2f0-0000-7000-8000-000000000001", email: "ada@acme.test", name: "Ada", passwordHash: "h:correct", emailVerifiedAt: new Date(0), anonymisedAt: null }
const verifiedKey: NewPasskey = { credentialId: new Uint8Array([1]), publicKey: new Uint8Array([2]), signCount: 0n, transports: [], aaguid: "00000000-0000-0000-0000-000000000000", backedUp: true, label: "Laptop" }
const stored: PasskeyRecord = { id: "pk-1", label: "Laptop", credentialId: new Uint8Array([1]), transports: [], backedUp: true, createdAt: new Date("2026-10-22T09:00:00Z"), lastUsedAt: null }
const credential = { id: "x", rawId: "x", type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" } }
const register: PasskeyRegisterRequest = { challengeId: "01939f4e-6d4e-7c1a-9a0e-3c1e4b6f8a21", credential: { ...credential, response: { clientDataJSON: "e30", attestationObject: "AA" } }, label: "Laptop" }

function harness(options: { methods?: ("totp" | "passkey")[]; held?: PasskeyRecord[]; account?: AccountRecord | null } = {}) {
  const held = [...(options.held ?? [])]
  const account = options.account === undefined ? ada : options.account
  const passkeys = {
    listForUser: vi.fn(async () => held),
    // As the real one decides under the person's lock: codes only with the first factor of any kind.
    add: vi.fn(async (_u: string, _p: NewPasskey, hashes: readonly string[] | null): Promise<{ passkey: PasskeyRecord; codesIssued: boolean } | null> => ({
      passkey: stored,
      codesIssued: hashes !== null && (options.methods ?? []).length === 0,
    })),
    rename: vi.fn(async (_u: string, id: string, label: string) => (held.some((p) => p.id === id) ? { ...stored, label } : null)),
    remove: vi.fn(async () => true),
  }
  const ceremonies = {
    creationOptions: vi.fn(async () => ({ challengeId: "c", options: {} })),
    requestOptions: vi.fn(async () => ({ challengeId: "c", options: {} })),
    verifyRegistration: vi.fn<() => Promise<NewPasskey | null>>(async () => verifiedKey),
    verifyAssertion: vi.fn<() => Promise<{ userId: string; passkeyId: string } | null>>(async () => ({ userId: ada.id, passkeyId: "pk-1" })),
  }
  const factors = { proveHolder: vi.fn(async () => "password" as const), verify: vi.fn(async () => "passkey" as const) }
  const mfaChallenges = { verify: vi.fn(async (token: string) => (token === "good" ? { userId: ada.id, slug: undefined, jti: "j" } : null)) }
  const sessions = { startIdentity: vi.fn(async (_a: AccountRecord, _c: unknown, slug?: string) => ({ response: { status: "signed-in" as const, user: { id: ada.id, email: ada.email, name: ada.name }, workspaces: [], session: slug === undefined ? null : { slug } }, cookies: [] })) }
  const notifier = { tell: vi.fn(async () => undefined) }
  const service = new PasskeyService(
    { findById: async () => account } as unknown as UserRepository,
    passkeys as unknown as PasskeyRepository,
    { methods: async () => options.methods ?? [] } as unknown as MfaRepository,
    ceremonies as unknown as PasskeyCeremonies,
    factors as unknown as MemberMfaService,
    mfaChallenges as unknown as MfaChallengeService,
    sessions as unknown as SessionService,
    { hash: async (plain: string) => `h:${plain}` } as unknown as PasswordService,
    notifier as unknown as AccountSecurityNotifier,
  )
  return { service, passkeys, ceremonies, factors, sessions, notifier }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("PasskeyService.registrationOptions", () => {
  it("proves the holder by the step-up rule before any challenge is issued", async () => {
    const h = harness()
    h.factors.proveHolder.mockRejectedValueOnce(new ValidationProblem([]))
    await expect(h.service.registrationOptions(ada.id, { password: "wrong" })).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.ceremonies.creationOptions).not.toHaveBeenCalled()
    await h.service.registrationOptions(ada.id, { password: "correct" })
    // A recovery code would end the session the next request needs (M13 review).
    expect(h.factors.proveHolder).toHaveBeenLastCalledWith(ada.id, { password: "correct" }, { recovery: false })
  })

  it("is refused to an erased account", async () => {
    const h = harness({ account: { ...ada, anonymisedAt: new Date() } })
    await expect(h.service.registrationOptions(ada.id, { password: "correct" })).rejects.toBeInstanceOf(NotAuthenticatedProblem)
  })
})

describe("PasskeyService.register", () => {
  it("shows ten recovery codes with a person's first factor, once, and says so by mail", async () => {
    const h = harness()
    const result = await h.service.register(ada.id, register)
    expect(result.recoveryCodes).toHaveLength(10)
    expect(result.passkey).toEqual({ id: "pk-1", label: "Laptop", createdAt: "2026-10-22T09:00:00.000Z", lastUsedAt: null, synced: true })
    expect(h.notifier.tell).toHaveBeenCalledWith(ada.id, "passkey-added", 10)
  })

  it("keeps the codes a person has when they already hold a factor", async () => {
    const h = harness({ methods: ["totp"] })
    const result = await h.service.register(ada.id, register)
    expect(result.recoveryCodes).toBeNull()
    expect(h.passkeys.add).toHaveBeenCalledWith(ada.id, verifiedKey, expect.any(Array))
    expect(h.notifier.tell).toHaveBeenCalledWith(ada.id, "passkey-added", 0)
  })

  it("is 400 for a credential that does not verify and 409 for one already registered", async () => {
    const h = harness()
    h.ceremonies.verifyRegistration.mockResolvedValueOnce(null)
    await expect(h.service.register(ada.id, register)).rejects.toBeInstanceOf(ValidationProblem)
    h.passkeys.add.mockResolvedValueOnce(null)
    await expect(h.service.register(ada.id, register)).rejects.toBeInstanceOf(ConflictProblem)
    expect(h.notifier.tell).not.toHaveBeenCalled()
  })
})

describe("PasskeyService.remove and rename", () => {
  it("takes a factor before removing, and is 404 for a passkey that is not the person's", async () => {
    const h = harness({ held: [stored] })
    await expect(h.service.remove(ada.id, "pk-other", { code: "123456" })).rejects.toBeInstanceOf(NotFoundProblem)
    expect(h.factors.verify).not.toHaveBeenCalled()
    h.factors.verify.mockRejectedValueOnce(new ValidationProblem([]))
    await expect(h.service.remove(ada.id, "pk-1", { code: "000000" })).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.passkeys.remove).not.toHaveBeenCalled()
    await h.service.remove(ada.id, "pk-1", { code: "123456" })
    expect(h.passkeys.remove).toHaveBeenCalledWith(ada.id, "pk-1")
    expect(h.notifier.tell).toHaveBeenCalledWith(ada.id, "passkey-removed", 0)
  })

  it("renames the person's own passkey on the session alone, and is 404 for anyone else's", async () => {
    const h = harness({ held: [stored] })
    expect((await h.service.rename(ada.id, "pk-1", "Phone")).label).toBe("Phone")
    await expect(h.service.rename(ada.id, "pk-other", "Phone")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

describe("PasskeyService proofs and sign-in", () => {
  it("offers a proof only to someone holding a passkey", async () => {
    await expect(harness().service.proofOptions(ada.id)).rejects.toBeInstanceOf(ConflictProblem)
    const h = harness({ held: [stored] })
    await h.service.proofOptions(ada.id)
    expect(h.ceremonies.requestOptions).toHaveBeenCalledWith("proof", ada.id, [stored])
  })

  it("issues the second step's challenge only against a live MFA challenge cookie", async () => {
    const h = harness({ held: [stored] })
    await expect(h.service.secondStepOptions(undefined)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    await expect(h.service.secondStepOptions("forged")).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    await h.service.secondStepOptions("good")
    expect(h.ceremonies.requestOptions).toHaveBeenCalledWith("proof", ada.id, [stored])
  })

  it("signs in with the passkey alone, opening the workspace it named", async () => {
    const h = harness()
    const result = await h.service.login({ challengeId: register.challengeId, credential, slug: "acme" }, client)
    expect(result.response.session).toEqual({ slug: "acme" })
    expect(h.ceremonies.verifyAssertion).toHaveBeenCalledWith("login", register.challengeId, credential, null)
  })

  it("answers one 401 for a refused assertion, an unverified account and an erased one", async () => {
    const refused = harness()
    refused.ceremonies.verifyAssertion.mockResolvedValueOnce(null)
    await expect(refused.service.login({ challengeId: register.challengeId, credential }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
    for (const account of [{ ...ada, emailVerifiedAt: null }, { ...ada, anonymisedAt: new Date() }, null]) {
      const h = harness({ account })
      await expect(h.service.login({ challengeId: register.challengeId, credential }, client)).rejects.toBeInstanceOf(NotAuthenticatedProblem)
      expect(h.sessions.startIdentity).not.toHaveBeenCalled()
    }
  })
})
