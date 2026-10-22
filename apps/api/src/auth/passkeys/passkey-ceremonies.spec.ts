import { Logger } from "@nestjs/common"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SoftAuthenticator } from "../../../test/support/soft-authenticator"
import { FixedClock } from "../../common/clock/clock"
import { ServiceUnavailableProblem } from "../../common/problems/problem.exception"
import type { AppConfig } from "../../config/app-config"
import type { NewPasskey, PasskeyRecord, PasskeyRepository, StoredCredential } from "../../platform/repositories/passkey.repository"
import type { RedisService } from "../../redis/redis.service"
import type { AccountSecurityNotifier } from "../mfa/account-security-notifier"
import { PasskeyCeremonies } from "./passkey-ceremonies"
import { PasskeyChallengeStore } from "./passkey-challenges"

const config = { ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], isProduction: false } as unknown as AppConfig
const NOW = new Date("2026-10-22T09:00:00Z")
const APP = "http://app.lvh.me:3001"
const ACME = "http://acme.lvh.me:3001"
const ada = { id: "0190b2f0-0000-7000-8000-000000000001", email: "ada@acme.test", name: "Ada" }
const bob = { id: "0190b2f0-0000-7000-8000-000000000002", email: "bob@acme.test", name: "Bob" }

/** In-memory Redis and repository with the real ones' semantics: `GETDEL`, and a counter-conditional update. */
function harness(options: { redisDown?: boolean } = {}) {
  const kv = new Map<string, string>()
  const fail = async () => {
    throw new Error("redis down")
  }
  const redis = {
    client: {
      set: options.redisDown === true ? fail : async (key: string, value: string) => (kv.set(key, value), "OK"),
      getdel: options.redisDown === true ? fail : async (key: string) => {
        const value = kv.get(key) ?? null
        kv.delete(key)
        return value
      },
    },
  }
  const rows: (StoredCredential & PasskeyRecord)[] = []
  const repo = {
    findByCredentialId: async (id: Uint8Array) => rows.find((r) => Buffer.from(r.credentialId).equals(Buffer.from(id))) ?? null,
    recordUse: async (id: string, read: bigint, next: bigint, backedUp: boolean, at: Date) => {
      const row = rows.find((r) => r.id === id && r.signCount === read)
      if (row === undefined) return false
      Object.assign(row, { signCount: next, backedUp, lastUsedAt: at })
      return true
    },
  }
  const notifier = { tell: vi.fn(async () => undefined) }
  const ceremonies = new PasskeyCeremonies(
    repo as unknown as PasskeyRepository,
    new PasskeyChallengeStore(redis as unknown as RedisService),
    notifier as unknown as AccountSecurityNotifier,
    config,
    new FixedClock(NOW),
  )
  /** Stores what a verified registration returns, as `PasskeyRepository.add` would. */
  const keep = (userId: string, passkey: NewPasskey) => {
    const row = { id: `pk-${String(rows.length + 1)}`, userId, createdAt: NOW, lastUsedAt: null, ...passkey }
    rows.push(row)
    return row
  }
  return { ceremonies, notifier, rows, keep }
}

/** Ada registers a passkey from the account page on `app.`. */
async function registered(h: ReturnType<typeof harness>, authenticator = new SoftAuthenticator()) {
  const ceremony = await h.ceremonies.creationOptions(ada, [])
  const verified = await h.ceremonies.verifyRegistration(ada.id, ceremony.challengeId, authenticator.create(ceremony.options, APP), "Laptop")
  if (verified === null) throw new Error("registration refused")
  return { row: h.keep(ada.id, verified), authenticator }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
})

describe("registration", () => {
  it("asks for a discoverable, user-verified credential on the root domain, without the person's existing ones", async () => {
    const h = harness()
    const { row } = await registered(h)
    const ceremony = await h.ceremonies.creationOptions(ada, [row])
    expect(ceremony.options.rp).toEqual({ id: "lvh.me", name: "Patchgrid" })
    expect(ceremony.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" })
    expect(ceremony.options.attestation).toBe("none")
    expect(ceremony.options.excludeCredentials?.map((c) => c.id)).toEqual([Buffer.from(row.credentialId).toString("base64url")])
    // The user handle is the id's bytes, nothing personal.
    expect(Buffer.from(ceremony.options.user.id, "base64url").toString("hex")).toBe(ada.id.replace(/-/g, ""))
  })

  it("stores the key, the counter and the synced flag the authenticator reported", async () => {
    const h = harness()
    const { row } = await registered(h, new SoftAuthenticator({ synced: true }))
    expect(row).toMatchObject({ signCount: 0n, backedUp: true, transports: ["internal"], label: "Laptop" })
    expect(row.publicKey.length).toBeGreaterThan(64)
  })

  it("refuses a challenge issued to someone else, spent already, or answered from a host a passkey does not count on", async () => {
    const h = harness()
    const device = new SoftAuthenticator()
    const forBob = await h.ceremonies.creationOptions(bob, [])
    expect(await h.ceremonies.verifyRegistration(ada.id, forBob.challengeId, device.create(forBob.options, APP), "x")).toBeNull()

    const once = await h.ceremonies.creationOptions(ada, [])
    const credential = device.create(once.options, APP)
    expect(await h.ceremonies.verifyRegistration(ada.id, once.challengeId, credential, "x")).not.toBeNull()
    expect(await h.ceremonies.verifyRegistration(ada.id, once.challengeId, credential, "x")).toBeNull()

    for (const origin of ["http://admin.lvh.me:3001", "http://www.lvh.me:3000", "http://lvh.me:3000", "http://evil.example:3001", "http://app.lvh.me:9999"]) {
      const ceremony = await h.ceremonies.creationOptions(ada, [])
      expect(await h.ceremonies.verifyRegistration(ada.id, ceremony.challengeId, device.create(ceremony.options, origin), "x"), origin).toBeNull()
    }
  })

  it("refuses an authenticator that did not verify its user", async () => {
    const h = harness()
    const ceremony = await h.ceremonies.creationOptions(ada, [])
    const credential = new SoftAuthenticator({ userVerified: false }).create(ceremony.options, APP)
    expect(await h.ceremonies.verifyRegistration(ada.id, ceremony.challengeId, credential, "x")).toBeNull()
  })
})

describe("assertion", () => {
  it("signs in alone on a workspace host: the credential names its owner, and the use is recorded", async () => {
    const h = harness()
    const { row, authenticator } = await registered(h)
    const ceremony = await h.ceremonies.requestOptions("login", null, [])
    expect(ceremony.options.allowCredentials).toBeUndefined()
    expect(ceremony.options.userVerification).toBe("required")
    const asserted = await h.ceremonies.verifyAssertion("login", ceremony.challengeId, authenticator.get(ceremony.options, ACME), null)
    expect(asserted).toEqual({ userId: ada.id, passkeyId: row.id })
    expect(row).toMatchObject({ signCount: 2n, lastUsedAt: NOW })
  })

  it("proves the person it was issued to, and no one else", async () => {
    const h = harness()
    const { row, authenticator } = await registered(h)
    const proof = await h.ceremonies.requestOptions("proof", ada.id, [row])
    expect(proof.options.allowCredentials).toHaveLength(1)
    expect(await h.ceremonies.verifyAssertion("proof", proof.challengeId, authenticator.get(proof.options, APP), ada.id)).not.toBeNull()

    // Bob's challenge, answered with Ada's passkey, proves neither of them.
    const bobs = await h.ceremonies.requestOptions("proof", bob.id, [row])
    expect(await h.ceremonies.verifyAssertion("proof", bobs.challengeId, authenticator.get(bobs.options, APP), bob.id)).toBeNull()
    const adas = await h.ceremonies.requestOptions("proof", ada.id, [row])
    expect(await h.ceremonies.verifyAssertion("proof", adas.challengeId, authenticator.get(adas.options, APP), bob.id)).toBeNull()
  })

  it("spends a challenge once, and only for the purpose it was issued for", async () => {
    const h = harness()
    const { row, authenticator } = await registered(h)
    const login = await h.ceremonies.requestOptions("login", null, [])
    const answer = authenticator.get(login.options, ACME)
    expect(await h.ceremonies.verifyAssertion("proof", login.challengeId, answer, null)).toBeNull()
    // Refused for the wrong purpose, the challenge is gone: it does not wait for the right one.
    expect(await h.ceremonies.verifyAssertion("login", login.challengeId, answer, null)).toBeNull()

    const proof = await h.ceremonies.requestOptions("proof", ada.id, [row])
    const proved = authenticator.get(proof.options, APP)
    expect(await h.ceremonies.verifyAssertion("proof", proof.challengeId, proved, ada.id)).not.toBeNull()
    expect(await h.ceremonies.verifyAssertion("proof", proof.challengeId, proved, ada.id)).toBeNull()
  })

  it("refuses the back-office, the marketing site, the apex and anything foreign, though the browser would sign there", async () => {
    const h = harness()
    const { authenticator } = await registered(h)
    for (const origin of ["http://admin.lvh.me:3001", "http://www.lvh.me:3000", "http://lvh.me:3000", "http://acme.lvh.me.evil.example:3001", "null"]) {
      const ceremony = await h.ceremonies.requestOptions("login", null, [])
      expect(await h.ceremonies.verifyAssertion("login", ceremony.challengeId, authenticator.get(ceremony.options, origin), null), origin).toBeNull()
    }
  })

  it("refuses an assertion for another relying party, an unknown credential, or a user handle that is not the owner's", async () => {
    const h = harness()
    const { authenticator } = await registered(h)
    const elsewhere = await h.ceremonies.requestOptions("login", null, [])
    expect(await h.ceremonies.verifyAssertion("login", elsewhere.challengeId, authenticator.get(elsewhere.options, ACME, { rpId: "evil.example" }), null)).toBeNull()

    const unknown = await h.ceremonies.requestOptions("login", null, [])
    const stranger = new SoftAuthenticator()
    const theirs = await h.ceremonies.creationOptions(bob, [])
    stranger.create(theirs.options, APP)
    expect(await h.ceremonies.verifyAssertion("login", unknown.challengeId, stranger.get(unknown.options, ACME), null)).toBeNull()

    const handle = await h.ceremonies.requestOptions("login", null, [])
    const answer = authenticator.get(handle.options, ACME)
    expect(await h.ceremonies.verifyAssertion("login", handle.challengeId, { ...answer, response: { ...answer.response, userHandle: Buffer.from(bob.id.replace(/-/g, ""), "hex").toString("base64url") } }, null)).toBeNull()
  })

  it("refuses a counter that went backwards and tells the person; a forged one with a low counter tells no one", async () => {
    const h = harness()
    const { authenticator } = await registered(h)
    const first = await h.ceremonies.requestOptions("login", null, [])
    expect(await h.ceremonies.verifyAssertion("login", first.challengeId, authenticator.get(first.options, ACME), null)).not.toBeNull()

    const forged = await h.ceremonies.requestOptions("login", null, [])
    const answer = authenticator.get(forged.options, ACME, { counter: 1 })
    expect(await h.ceremonies.verifyAssertion("login", forged.challengeId, { ...answer, response: { ...answer.response, signature: "AAAA" } }, null)).toBeNull()
    expect(h.notifier.tell).not.toHaveBeenCalled()

    const cloned = await h.ceremonies.requestOptions("login", null, [])
    expect(await h.ceremonies.verifyAssertion("login", cloned.challengeId, authenticator.get(cloned.options, ACME, { counter: 1 }), null)).toBeNull()
    expect(h.notifier.tell).toHaveBeenCalledWith(ada.id, "passkey-cloned", 0)
  })

  it("never counts a synced passkey, which reports zero every time", async () => {
    const h = harness()
    const { authenticator } = await registered(h, new SoftAuthenticator({ synced: true }))
    for (let i = 0; i < 3; i += 1) {
      const ceremony = await h.ceremonies.requestOptions("login", null, [])
      expect(await h.ceremonies.verifyAssertion("login", ceremony.challengeId, authenticator.get(ceremony.options, ACME), null)).not.toBeNull()
    }
    expect(h.notifier.tell).not.toHaveBeenCalled()
  })

  it("answers 503 with Redis down, never an unchecked ceremony", async () => {
    const h = harness({ redisDown: true })
    await expect(h.ceremonies.requestOptions("login", null, [])).rejects.toBeInstanceOf(ServiceUnavailableProblem)
  })
})
