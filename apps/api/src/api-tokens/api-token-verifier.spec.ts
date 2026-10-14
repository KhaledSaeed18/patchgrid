import { describe, expect, it, vi } from "vitest"

import type { PasswordService } from "../auth/passwords/password.service"
import { FixedClock } from "../common/clock/clock"
import { ApiTokenVerifier } from "./api-token-verifier"
import type { ApiTokenCredential, ApiTokenRepository } from "./repositories/api-token.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T12:00:00Z")
const SECRET = "s".repeat(43)

function harness(over: Partial<ApiTokenCredential> = {}, membership: Partial<ApiTokenCredential["membership"]> = {}) {
  const row: ApiTokenCredential = {
    id: "tok-1",
    tokenHash: "hash",
    scopes: ["tickets:read"],
    membershipId: "m-svc",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over,
    membership: {
      role: "AGENT",
      status: "ACTIVE",
      kind: "SERVICE_ACCOUNT",
      ...membership,
    },
  }
  const tokens = {
    credential: vi.fn(async () => row as ApiTokenCredential | null),
    markUsed: vi.fn(async () => undefined),
  }
  const passwords = {
    verify: vi.fn(async (_hash: string | null, secret: string) => secret === SECRET),
  }
  const clock = new FixedClock(NOW)
  const verifier = new ApiTokenVerifier(tokens as unknown as ApiTokenRepository, passwords as unknown as PasswordService, clock)
  return { verifier, tokens, passwords, clock, row }
}

describe("ApiTokenVerifier", () => {
  it("makes a live token's service account the actor, narrowed to its scopes", async () => {
    const h = harness()
    expect(await h.verifier.verify(ORG, "p", SECRET)).toEqual({
      kind: "service",
      orgId: ORG,
      membershipId: "m-svc",
      role: "AGENT",
      scopes: ["tickets:read"],
      tokenId: "tok-1",
    })
    expect(h.tokens.markUsed).toHaveBeenCalledWith(ORG, "tok-1", NOW, new Date(NOW.getTime() - 60_000))
  })

  it("refuses a wrong secret, an unknown prefix, a revoked or expired token, and a service account that is not active", async () => {
    expect(await harness().verifier.verify(ORG, "p", "t".repeat(43))).toBeNull()
    const unknown = harness()
    unknown.tokens.credential.mockResolvedValueOnce(null)
    expect(await unknown.verifier.verify(ORG, "p", SECRET)).toBeNull()
    expect(await harness({ revokedAt: NOW }).verifier.verify(ORG, "p", SECRET)).toBeNull()
    expect(await harness({ expiresAt: NOW }).verifier.verify(ORG, "p", SECRET)).toBeNull()
    expect(await harness({}, { status: "DISABLED" }).verifier.verify(ORG, "p", SECRET)).toBeNull()
    expect(await harness({}, { kind: "HUMAN" }).verifier.verify(ORG, "p", SECRET)).toBeNull()
  })

  it("pays Argon2id once per five minutes per token, and the row still decides in between", async () => {
    const h = harness()
    await h.verifier.verify(ORG, "p", SECRET)
    await h.verifier.verify(ORG, "p", SECRET)
    expect(h.passwords.verify).toHaveBeenCalledTimes(1)
    // A cached digest is no answer to a different secret.
    expect(await h.verifier.verify(ORG, "p", "t".repeat(43))).toBeNull()
    // Nor does it outlive a revocation.
    h.tokens.credential.mockResolvedValueOnce({ ...h.row, revokedAt: NOW })
    expect(await h.verifier.verify(ORG, "p", SECRET)).toBeNull()
    h.clock.advance(5 * 60_000)
    await h.verifier.verify(ORG, "p", SECRET)
    expect(h.passwords.verify).toHaveBeenCalledTimes(3)
  })
})
