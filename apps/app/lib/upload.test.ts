import { MAX_ATTACHMENT_BYTES } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { fileProblem, readableSize } from "./upload"

describe("what may be attached", () => {
  it("lets an allow-listed file under the ceiling be tried", () => {
    expect(
      fileProblem({ name: "a.png", type: "image/png", size: 10 })
    ).toBeNull()
    expect(
      fileProblem({
        name: "a.pdf",
        type: "application/pdf",
        size: MAX_ATTACHMENT_BYTES,
      })
    ).toBeNull()
  })

  it("says why not for an empty, oversized, or disallowed file — an SVG among them", () => {
    expect(fileProblem({ name: "a.txt", type: "text/plain", size: 0 })).toMatch(
      /empty/
    )
    expect(
      fileProblem({
        name: "big.zip",
        type: "application/zip",
        size: MAX_ATTACHMENT_BYTES + 1,
      })
    ).toMatch(/larger than 10 MB/)
    expect(
      fileProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 })
    ).toMatch(/isn't a type/)
    expect(
      fileProblem({ name: "page.html", type: "text/html", size: 10 })
    ).toMatch(/isn't a type/)
  })
})

describe("sizes", () => {
  it("read like people say them", () => {
    expect(readableSize(500)).toBe("500 B")
    expect(readableSize(812 * 1024)).toBe("812 KB")
    expect(readableSize(3.4 * 1024 * 1024)).toBe("3.4 MB")
  })
})
