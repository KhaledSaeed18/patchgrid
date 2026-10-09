import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { auditActionSchema } from "./audit.ts"

const RBAC = readFileSync(new URL("../../../docs/RBAC.md", import.meta.url), "utf8")

describe("the audit catalogue", () => {
  it("names only actions RBAC.md §12 lists", () => {
    const section = RBAC.slice(RBAC.indexOf("## 12."), RBAC.indexOf("## 13."))
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
