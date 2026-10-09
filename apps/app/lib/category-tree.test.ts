import { describe, expect, it } from "vitest"

import { categoryPath, inTreeOrder } from "./category-tree"

const c = (
  id: string,
  parentId: string | null,
  name: string,
  sortOrder = 0
) => ({ id, parentId, name, sortOrder })

describe("inTreeOrder", () => {
  it("puts each parent before its children, siblings by sort order then name", () => {
    const list = [
      c("l", "hw", "Laptops"),
      c("sw", null, "Software"),
      c("o2", "sw", "Other"),
      c("hw", null, "Hardware"),
      c("o1", "hw", "Other", 9),
      c("b", "l", "Battery"),
    ]
    expect(inTreeOrder(list).map((x) => x.id)).toEqual([
      "hw",
      "l",
      "b",
      "o1",
      "sw",
      "o2",
    ])
  })

  it("drops a subtree whose parent is not in the list", () => {
    expect(
      inTreeOrder([c("l", "gone", "Laptops"), c("sw", null, "Software")]).map(
        (x) => x.id
      )
    ).toEqual(["sw"])
  })
})

describe("categoryPath", () => {
  it("names every ancestor, so two Others can be told apart", () => {
    const list = [
      c("hw", null, "Hardware"),
      c("l", "hw", "Laptops"),
      c("b", "l", "Battery"),
    ]
    const byId = new Map(list.map((x) => [x.id, x]))
    expect(categoryPath(list[2] ?? c("", null, ""), byId)).toBe(
      "Hardware / Laptops / Battery"
    )
  })
})
