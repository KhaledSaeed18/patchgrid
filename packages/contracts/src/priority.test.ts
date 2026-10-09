import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { computePriority, DEFAULT_SLA_TARGETS, impactSchema, PRIORITY_MATRIX, urgencySchema } from "./priority.ts"

const DOMAIN = readFileSync(new URL("../../../docs/DOMAIN.md", import.meta.url), "utf8")
const cells = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim().replaceAll("*", ""))
const upper = (s: string) => s.toUpperCase()

/** "15 min" → 15, "4 h" → 240. */
function minutes(cell: string): number {
  const [n = "", unit] = cell.split(" ")
  return unit === "h" ? Number(n) * 60 : Number(n)
}

describe("the priority matrix", () => {
  it("is DOMAIN.md §3's table, cell for cell", () => {
    const section = DOMAIN.slice(DOMAIN.indexOf("## 3. Priority matrix"), DOMAIN.indexOf("## 4."))
    const rows = section.split("\n").filter((l) => /^\| \*\*(High|Medium|Low)\*\*/.test(l))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const [impact = "", low = "", medium = "", high = ""] = cells(row)
      expect(PRIORITY_MATRIX[upper(impact) as keyof typeof PRIORITY_MATRIX]).toEqual({
        LOW: upper(low),
        MEDIUM: upper(medium),
        HIGH: upper(high),
      })
    }
  })

  it("covers every combination", () => {
    for (const impact of impactSchema.options) {
      for (const urgency of urgencySchema.options) expect(computePriority(impact, urgency)).toBeDefined()
    }
  })
})

describe("the default SLA targets", () => {
  it("are DOMAIN.md §4.1's table", () => {
    const section = DOMAIN.slice(DOMAIN.indexOf("### 4.1 Policy"), DOMAIN.indexOf("### 4.2"))
    const rows = section.split("\n").filter((l) => /^\| (Critical|High|Medium|Low) \|/.test(l))
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      const [priority = "", response = "", responseWarning = "", resolution = "", resolutionWarning = ""] = cells(row)
      expect(DEFAULT_SLA_TARGETS[upper(priority) as keyof typeof DEFAULT_SLA_TARGETS]).toEqual({
        response: minutes(response),
        responseWarning: minutes(responseWarning),
        resolution: minutes(resolution),
        resolutionWarning: minutes(resolutionWarning),
      })
    }
  })
})
