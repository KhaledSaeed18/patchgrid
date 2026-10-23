import { createElement } from "react"
import { describe, expect, it } from "vitest"

import { anchorFor, textOf } from "./headings"

describe("textOf", () => {
  it("reads through inline code and emphasis", () => {
    const heading = ["The ", createElement("code", null, "version"), " field"]
    expect(textOf(heading)).toBe("The version field")
  })
})

describe("anchorFor", () => {
  it("keeps letters, digits and single hyphens", () => {
    expect(anchorFor("Who can approve a change?")).toBe(
      "who-can-approve-a-change"
    )
    expect(anchorFor("401, 403 & 404 — the difference")).toBe(
      "401-403-404-the-difference"
    )
  })
})
