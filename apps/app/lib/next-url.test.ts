// @vitest-environment node
import { describe, expect, it } from "vitest"

import { parseNext } from "./next-url"

describe("parseNext", () => {
  it("accepts a local path and a URL on one of our hosts", () => {
    expect(parseNext("/workspaces")).toEqual({
      kind: "path",
      path: "/workspaces",
    })
    expect(parseNext("http://acme.lvh.me:3001/tickets?x=1")).toEqual({
      kind: "workspace",
      slug: "acme",
      url: "http://acme.lvh.me:3001/tickets?x=1",
    })
    expect(parseNext("http://app.lvh.me:3001/new")).toEqual({
      kind: "path",
      path: "/new",
    })
  })

  it("refuses anything that would make login an open redirect", () => {
    for (const bad of [
      "//evil.test/x",
      "/\\evil.test",
      "https://evil.test",
      "https://acme.lvh.me.evil.test/",
      "javascript:alert(1)",
      "http://api.lvh.me:4000/",
      "",
      null,
    ]) {
      expect(parseNext(bad), String(bad)).toBeNull()
    }
  })
})
