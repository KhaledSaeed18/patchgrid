// @vitest-environment node
import type { AuditEntry } from "@patchgrid/contracts"
import { describe as suite, expect, it } from "vitest"

import { describe } from "./audit-text"

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "0190b2f0-0000-7000-8000-000000000001",
  action: "MEMBER_DISABLED",
  entityType: "Membership",
  entityId: "0190b2f0-0000-7000-8000-00000000000a",
  diff: {},
  actor: { kind: "MEMBER", membershipId: "m", displayName: "Dana" },
  createdAt: "2026-10-09T12:00:00.000Z",
  ...over,
})
const names = (id: string) =>
  id === "0190b2f0-0000-7000-8000-00000000000a" ? "Sam" : undefined

suite("audit sentences", () => {
  it("names who did what to whom", () => {
    expect(
      describe(
        entry({
          action: "MEMBER_ROLE_CHANGED",
          diff: { role: { from: "AGENT", to: "ADMIN" } },
        }),
        names
      )
    ).toBe("Dana changed Sam's role from Agent to Admin")
    expect(describe(entry({}), names)).toBe("Dana paused Sam's access")
    expect(
      describe(
        entry({
          action: "MEMBER_INVITED",
          diff: { email: "x@acme.test", role: "AGENT" },
        }),
        names
      )
    ).toBe("Dana invited x@acme.test as agent")
  })

  it("never shows an empty actor or target", () => {
    expect(
      describe(
        entry({
          actor: { kind: "SYSTEM", membershipId: null, displayName: null },
          entityId: "0190b2f0-0000-7000-8000-0000000000ff",
        }),
        names
      )
    ).toBe("Patchgrid paused a member's access")
    expect(describe(entry({ action: "AGENT_VISIBILITY_CHANGED" }), names)).toBe(
      "Dana changed what agents can see"
    )
  })
})
