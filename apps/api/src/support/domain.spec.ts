import { describe, expect, it } from "vitest"

import { statusOf } from "./domain"

const NOW = new Date("2026-10-15T12:00:00Z")
const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000)
const base = { grantedAt: null, declinedAt: null, expiresAt: null, endedAt: null }

describe("a support session's status", () => {
  it("is requested, declined, active or ended by its timestamps alone", () => {
    expect(statusOf(base, NOW)).toBe("REQUESTED")
    expect(statusOf({ ...base, declinedAt: at(-1) }, NOW)).toBe("DECLINED")
    expect(statusOf({ ...base, grantedAt: at(-1), expiresAt: at(1) }, NOW)).toBe("ACTIVE")
    expect(statusOf({ ...base, grantedAt: at(-1), expiresAt: at(1), endedAt: at(-0.5) }, NOW)).toBe("ENDED")
    // Past its expiry before the sweep has run: already ended.
    expect(statusOf({ ...base, grantedAt: at(-3), expiresAt: at(-1) }, NOW)).toBe("ENDED")
  })
})
