import { describe, expect, it } from "vitest"

import { csvCell, duration, percent, rangeFor } from "./range"

describe("report ranges and figures", () => {
  it("ends a range at the next whole minute, so server and client ask the same thing", () => {
    const range = rangeFor(30, new Date("2026-10-17T12:00:30.500Z"))
    expect(range).toEqual({ from: "2026-09-17T12:01:00.000Z", to: "2026-10-17T12:01:00.000Z" })
  })

  it("has no share of nothing, and rounds a share to a tenth", () => {
    expect(percent(0, 0)).toBeNull()
    expect(percent(2, 3)).toBe(66.7)
  })

  it("quotes a CSV cell and defuses one a spreadsheet would run as a formula", () => {
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell("-1")).toBe(`"'-1"`)
    expect(csvCell(42)).toBe('"42"')
  })

  it("reads minutes the way a person would", () => {
    expect(duration(null)).toBe("—")
    expect(duration(45)).toBe("45 min")
    expect(duration(210)).toBe("3.5 h")
    expect(duration(3_024)).toBe("2.1 d")
  })
})
