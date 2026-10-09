import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { auditActionSchema, auditQuerySchema } from "./audit.ts"

const RBAC = readFileSync(new URL("../../../docs/RBAC.md", import.meta.url), "utf8")
const DOMAIN = readFileSync(new URL("../../../docs/DOMAIN.md", import.meta.url), "utf8")

describe("the audit catalogue", () => {
  it("names only actions RBAC.md §12 or DOMAIN.md §7 lists", () => {
    const section =
      RBAC.slice(RBAC.indexOf("## 12."), RBAC.indexOf("## 13.")) +
      DOMAIN.slice(DOMAIN.indexOf("## 7."), DOMAIN.indexOf("## 8."))
    // `TEAM_CREATED/UPDATED/DELETED` abbreviates three actions.
    const listed = new Set(
      [...section.matchAll(/`([A-Z_]+(?:\/[A-Z_]+)*)`/g)].flatMap((m) => {
        const [first = "", ...rest] = (m[1] ?? "").split("/")
        const stem = first.slice(0, first.lastIndexOf("_") + 1)
        return [first, ...rest.map((r) => stem + r)]
      }),
    )
    expect(auditActionSchema.options.filter((a) => !listed.has(a))).toEqual([])
  })
})

describe("the audit query", () => {
  it("pages by default, filters by known actions only, and wants a range in order", () => {
    expect(auditQuerySchema.parse({})).toEqual({ limit: 25 })
    expect(auditQuerySchema.safeParse({ action: "MEMBER_EXPLODED" }).success).toBe(false)
    expect(auditQuerySchema.safeParse({ from: "2026-10-09T00:00:00Z", to: "2026-10-01T00:00:00Z" }).success).toBe(false)
    expect(auditQuerySchema.safeParse({ from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z" }).success).toBe(true)
  })
})
