import { describe, expect, it } from "vitest"

import { approvalRoute } from "./approvers"

const owner = { membershipId: "m-owner", role: "OWNER" as const }
const admin = { membershipId: "m-admin", role: "ADMIN" as const }
const lead = { membershipId: "m-lead", role: "AGENT" as const }

describe("approvalRoute (DOMAIN.md §2.3)", () => {
  it("is others' when anyone able to decide is not the change's requester or assignee", () => {
    expect(approvalRoute([owner, admin], ["m-owner", null])).toEqual({ kind: "others" })
    expect(approvalRoute([owner, lead], ["m-owner", "m-agent"])).toEqual({ kind: "others" })
  })

  it("lets the one owner of a one-admin workspace decide their own change", () => {
    expect(approvalRoute([owner], ["m-owner", null])).toEqual({ kind: "self", ownerMembershipId: "m-owner" })
    expect(approvalRoute([owner, owner], ["m-owner", "m-owner"])).toEqual({ kind: "self", ownerMembershipId: "m-owner" })
  })

  it("is nobody's when the only other admin was made the assignee: rule 3 is not a way round rule 1", () => {
    expect(approvalRoute([owner, admin], ["m-owner", "m-admin"])).toEqual({ kind: "nobody" })
    expect(approvalRoute([admin], ["m-admin", null])).toEqual({ kind: "nobody" })
    expect(approvalRoute([], ["m-agent", null])).toEqual({ kind: "nobody" })
  })
})
