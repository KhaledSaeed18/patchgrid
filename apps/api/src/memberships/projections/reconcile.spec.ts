import { describe, expect, it } from "vitest"

import { driftOf, expectedRows, type IndexRow, planReconcile, type ProjectionSource } from "./reconcile"

const source: ProjectionSource = {
  org: { slug: "acme", name: "Acme", status: "ACTIVE" },
  members: [
    { userId: "u-owner", role: "OWNER", status: "ACTIVE" },
    { userId: "u-agent", role: "AGENT", status: "DISABLED" },
    { userId: "u-gone", role: "AGENT", status: "REMOVED" },
    { userId: "u-invited", role: "AGENT", status: "INVITED" },
  ],
}
const row = (userId: string, over: Partial<IndexRow> = {}): IndexRow => ({
  userId,
  roleForDisplay: "OWNER",
  statusForDisplay: "ACTIVE",
  orgSlug: "acme",
  orgName: "Acme",
  orgStatus: "ACTIVE",
  ...over,
})

describe("the org picker's projection (ADR-0022)", () => {
  it("expects a row per active or disabled member, none for the removed or invited, with their role and status and the org's names", () => {
    expect(expectedRows(source)).toEqual([row("u-owner"), row("u-agent", { roleForDisplay: "AGENT", statusForDisplay: "DISABLED" })])
  })

  it("plans nothing when the rows are true", () => {
    const plan = planReconcile(expectedRows(source), expectedRows(source))
    expect(driftOf(plan)).toBe(0)
  })

  it("adds a missing row, rewrites a stale one, and drops one for someone removed or never there", () => {
    const actual = [
      row("u-owner", { orgName: "Acme (old name)" }),
      row("u-gone", { roleForDisplay: "AGENT" }),
      row("u-stranger"),
    ]
    const plan = planReconcile(expectedRows(source), actual)
    expect(plan.create.map((r) => r.userId)).toEqual(["u-agent"])
    expect(plan.update).toEqual([row("u-owner")])
    expect(plan.remove).toEqual(["u-gone", "u-stranger"])
    expect(driftOf(plan)).toBe(4)
  })
})
