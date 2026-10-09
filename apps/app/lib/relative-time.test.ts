// @vitest-environment node
import { describe, expect, it } from "vitest"

import { relativeTime } from "./relative-time"

const NOW = new Date("2026-10-09T12:00:00Z")
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

describe("relativeTime", () => {
  it("picks the unit that keeps the number small, both ways", () => {
    expect(relativeTime(at(25), NOW)).toBe("in 25 minutes")
    expect(relativeTime(at(-180), NOW)).toBe("3 hours ago")
    expect(relativeTime(at(-1440), NOW)).toBe("yesterday")
    expect(relativeTime(at(0.5), NOW)).toBe("in under a minute")
    expect(relativeTime(at(-0.5), NOW)).toBe("just now")
  })
})
