// @vitest-environment node
import { describe, expect, it } from "vitest"

import { formatDuration, parseDuration } from "./duration"

describe("durations", () => {
  it("formats minutes the way the SLA table reads", () => {
    expect(formatDuration(15)).toBe("15m")
    expect(formatDuration(75)).toBe("1h 15m")
    expect(formatDuration(72 * 60)).toBe("3d")
  })

  it("reads what people type, and refuses zero and nonsense", () => {
    expect(parseDuration("1h 15m")).toBe(75)
    expect(parseDuration("2d4h")).toBe(52 * 60)
    expect(parseDuration(" 90 ")).toBe(90)
    expect(parseDuration("0h")).toBeNull()
    expect(parseDuration("soon")).toBeNull()
    expect(parseDuration("4 hours")).toBeNull()
  })

  it("round-trips", () => {
    for (const n of [1, 59, 60, 61, 1440, 1501, 129_600])
      expect(parseDuration(formatDuration(n))).toBe(n)
  })
})
