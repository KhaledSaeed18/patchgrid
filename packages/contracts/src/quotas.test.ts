import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { limitFor, PLAN_LIMITS, usagePeriod } from "./quotas.ts"

const TENANCY = readFileSync(new URL("../../../docs/TENANCY.md", import.meta.url), "utf8")

describe("plan limits", () => {
  it("are the numbers TENANCY.md §8 states", () => {
    const section = TENANCY.slice(TENANCY.indexOf("## 8."), TENANCY.indexOf("## 9."))
    const row = (label: string) => {
      const line = section.split("\n").find((l) => l.startsWith(`| ${label}`)) ?? ""
      return line.split("|").slice(2, 4).map((c) => c.trim())
    }
    const parse = (cell: string): number | null => {
      if (cell === "unlimited") return null
      const gb = /^(\d+) GB$/.exec(cell)
      return gb === null ? Number(cell.replaceAll(" ", "")) : Number(gb[1]) * 1024 ** 3
    }
    const rows = {
      AGENT_SEATS: row("Agent seats"),
      TICKETS_CREATED: row("Tickets per calendar month"),
      STORAGE_BYTES: row("Attachment storage"),
      AUTOMATION_RULES: row("Automation rules"),
      KB_ARTICLES: row("Knowledge articles"),
    }
    for (const [metric, [free = "", pro = ""]] of Object.entries(rows)) {
      expect([parse(free), parse(pro)], metric).toEqual([
        PLAN_LIMITS.FREE[metric as keyof typeof PLAN_LIMITS.FREE],
        PLAN_LIMITS.PRO[metric as keyof typeof PLAN_LIMITS.PRO],
      ])
    }
  })

  it("count tickets per UTC month and everything else as a point in time", () => {
    expect(usagePeriod("TICKETS_CREATED", new Date("2026-10-31T23:30:00-02:00"))).toBe("2026-11")
    expect(usagePeriod("AGENT_SEATS", new Date("2026-10-09T00:00:00Z"))).toBe("current")
    expect(limitFor("PRO", "KB_ARTICLES")).toBeNull()
  })
})
