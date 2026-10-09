// @vitest-environment node
import { describe, expect, it } from "vitest"

import { homeFor, navigationFor } from "./navigation"

describe("navigation", () => {
  it("shows a requester their tickets and nothing to configure", () => {
    const nav = navigationFor(["ticket:create", "ticket:read", "member:read"])
    expect(nav.flatMap((s) => s.items.map((i) => i.href))).toEqual(["/tickets"])
    expect(homeFor(["ticket:create"])).toBe("/tickets")
  })

  it("gives an admin the queues and the settings they hold", () => {
    const nav = navigationFor([
      "ticket:create",
      "ticket:assign",
      "org:read_settings",
      "member:invite",
      "team:read",
      "org:read_audit",
    ])
    expect(nav.map((s) => s.label)).toEqual([null, "Settings"])
    expect(nav[1]?.items.map((i) => i.label)).toEqual([
      "Workspace",
      "Members",
      "Teams",
      "Audit log",
    ])
    expect(homeFor(["ticket:assign"])).toBe("/queues")
  })
})
