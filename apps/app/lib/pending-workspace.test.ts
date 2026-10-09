// @vitest-environment node
import { describe, expect, it } from "vitest"

import { parsePendingWorkspace } from "./pending-workspace"

describe("parsePendingWorkspace", () => {
  it("reads the marketing site's cookie, encoded or already decoded", () => {
    const value = { name: "Acme IT", slug: "acme-it" }
    expect(
      parsePendingWorkspace(encodeURIComponent(JSON.stringify(value)))
    ).toEqual(value)
    expect(parsePendingWorkspace(JSON.stringify(value))).toEqual(value)
  })

  it("ignores anything else rather than failing the page", () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      "%E0%A4%A",
      JSON.stringify({ name: 1 }),
      "null",
    ]) {
      expect(parsePendingWorkspace(raw)).toBeNull()
    }
  })
})
