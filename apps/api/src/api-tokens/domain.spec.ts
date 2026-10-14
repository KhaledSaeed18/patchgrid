import { API_TOKEN_PATTERN } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { mintToken, statusOf } from "./domain"

describe("an API token", () => {
  it("is minted in the shape the bearer path accepts, with a fresh prefix and secret each time", () => {
    const a = mintToken()
    const b = mintToken()
    const match = API_TOKEN_PATTERN.exec(a.token)
    expect(match?.[1]).toBe(a.prefix)
    expect(match?.[2]).toBe(a.secret)
    expect(a.prefix).not.toBe(b.prefix)
    expect(a.secret).not.toBe(b.secret)
  })

  it("is revoked before it is expired, and expired at its expiry, not after", () => {
    const now = new Date("2026-10-15T12:00:00Z")
    expect(statusOf({ revokedAt: null, expiresAt: null }, now)).toBe("ACTIVE")
    expect(statusOf({ revokedAt: null, expiresAt: new Date("2026-10-15T12:00:01Z") }, now)).toBe("ACTIVE")
    expect(statusOf({ revokedAt: null, expiresAt: now }, now)).toBe("EXPIRED")
    expect(statusOf({ revokedAt: now, expiresAt: new Date("2026-10-01T00:00:00Z") }, now)).toBe("REVOKED")
  })
})
