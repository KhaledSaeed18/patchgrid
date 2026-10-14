import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import type { MembershipRecord, MembershipRepository } from "../../memberships/repositories/membership.repository"
import type { MemberActor } from "../actor"
import type { RevocationEpochService } from "../revocation/revocation-epoch.service"
import { StandingService } from "./standing.service"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const actor: MemberActor = { kind: "member", userId: "u-1", orgId: ORG, membershipId: "m-1", role: "AGENT", teamIds: ["t-1"], leadOfTeamIds: [] }

function harness(revoked: boolean | null, membership: Partial<MembershipRecord> | null) {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
  const findById = vi.fn(async () => (membership === null ? null : ({ id: "m-1", userId: "u-1", status: "ACTIVE", role: "AGENT", teamIds: ["t-1"], leadOfTeamIds: [], ...membership } as MembershipRecord)))
  const service = new StandingService(
    { isRevoked: vi.fn(async () => revoked) } as unknown as RevocationEpochService,
    { findById } as unknown as MembershipRepository,
  )
  return { service, findById }
}

describe("StandingService.check", () => {
  it("is null for a revoked session, without reading the membership", async () => {
    const h = harness(true, {})
    expect(await h.service.check(actor, 100)).toBeNull()
    expect(h.findById).not.toHaveBeenCalled()
  })

  it("is null for a membership gone, no longer active, or now someone else's", async () => {
    expect(await harness(false, null).service.check(actor, 100)).toBeNull()
    expect(await harness(false, { status: "DISABLED" }).service.check(actor, 100)).toBeNull()
    expect(await harness(false, { userId: "u-2" }).service.check(actor, 100)).toBeNull()
  })

  it("is the member as they are now — read in their tenant — even when the epoch is unknown", async () => {
    const h = harness(null, { role: "REQUESTER", teamIds: [] })
    expect(await h.service.check(actor, 100)).toEqual({ ...actor, role: "REQUESTER", teamIds: [] })
    expect(h.findById).toHaveBeenCalledWith(ORG, "m-1")
  })
})
