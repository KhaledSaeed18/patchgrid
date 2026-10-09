import { describe, expect, it } from "vitest"

import { ancestors, planMove, routeTeam, subtree, type TreeNode, visible } from "./tree"

// Hardware → Laptop → Screen; Software → Email; Network (inactive) → VPN
const node = (id: string, parentId: string | null, depth: number, over: Partial<TreeNode> = {}): TreeNode => ({
  id,
  parentId,
  depth,
  defaultTeamId: null,
  isActive: true,
  ...over,
})
const TREE: TreeNode[] = [
  node("hw", null, 1, { defaultTeamId: "it" }),
  node("laptop", "hw", 2),
  node("screen", "laptop", 3, { defaultTeamId: "repairs" }),
  node("sw", null, 1),
  node("email", "sw", 2),
  node("net", null, 1, { isActive: false }),
  node("vpn", "net", 2),
]

describe("the category tree", () => {
  it("walks down and up", () => {
    expect(subtree("hw", TREE).map((n) => n.id)).toEqual(["hw", "laptop", "screen"])
    expect(ancestors("screen", TREE).map((n) => n.id)).toEqual(["laptop", "hw"])
  })

  it("routes to the nearest default team up the tree, or to no team", () => {
    expect(routeTeam("screen", TREE)).toBe("repairs")
    expect(routeTeam("laptop", TREE)).toBe("it")
    expect(routeTeam("email", TREE)).toBeNull()
    expect(routeTeam("missing", TREE)).toBeNull()
  })

  it("hides what is inactive, and everything under it", () => {
    const shown = visible(TREE)
    expect(shown.has("net")).toBe(false)
    expect(shown.has("vpn")).toBe(false)
    expect(shown.has("screen")).toBe(true)
  })
})

describe("moving a category", () => {
  it("recomputes the depth of the whole subtree", () => {
    const plan = planMove("laptop", null, TREE)
    expect(plan).toEqual({ ok: true, depths: new Map([["laptop", 1], ["screen", 2]]) })
  })

  it("refuses a move past three levels, into itself, or under an inactive or unknown parent", () => {
    expect(planMove("hw", "email", TREE)).toEqual({ ok: false, reason: "too-deep" })
    expect(planMove("hw", "screen", TREE)).toEqual({ ok: false, reason: "cycle" })
    expect(planMove("email", "net", TREE)).toEqual({ ok: false, reason: "inactive-parent" })
    expect(planMove("email", "nope", TREE)).toEqual({ ok: false, reason: "unknown-parent" })
  })

  it("allows a move that fits exactly", () => {
    expect(planMove("email", "laptop", TREE)).toEqual({ ok: true, depths: new Map([["email", 3]]) })
  })
})
