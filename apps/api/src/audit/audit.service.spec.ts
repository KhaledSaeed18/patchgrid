import { describe, expect, it } from "vitest"

import type { Actor, ActorService } from "../auth/actor"
import { FixedClock } from "../common/clock/clock"
import { nextMonth } from "./audit-partitions"
import { AuditService } from "./audit.service"
import type { AuditLogRepository, AuditRow } from "./repositories/audit-log.repository"

const NOW = new Date("2026-10-09T10:00:00Z")

function serviceFor(actor: Actor | undefined) {
  const appended: { orgId: string; rows: readonly AuditRow[] }[] = []
  const repository = {
    append: (orgId: string, rows: readonly AuditRow[]) => {
      appended.push({ orgId, rows })
      return Promise.resolve()
    },
  } as unknown as AuditLogRepository
  const actors = { current: () => actor } as unknown as ActorService
  return { service: new AuditService(repository, actors, new FixedClock(NOW)), appended }
}

const entry = { action: "MEMBER_DISABLED", entityType: "Membership", entityId: "m-2" } as const

describe("AuditService", () => {
  it("attributes a member's change to their membership, stamped by the clock", async () => {
    const { service, appended } = serviceFor({
      kind: "member",
      userId: "u-1",
      orgId: "o-1",
      membershipId: "m-1",
      role: "ADMIN",
      teamIds: [],
      leadOfTeamIds: [],
    })
    await service.record("o-1", [entry])
    expect(appended).toEqual([
      {
        orgId: "o-1",
        rows: [{ ...entry, diff: {}, actorKind: "MEMBER", actorMembershipId: "m-1", createdAt: NOW }],
      },
    ])
  })

  it("attributes a token's change to SERVICE, never to a colleague", async () => {
    const { service, appended } = serviceFor({
      kind: "service",
      orgId: "o-1",
      membershipId: "m-svc",
      role: "AGENT",
      scopes: [],
    })
    await service.record("o-1", [entry])
    expect(appended[0]?.rows[0]).toMatchObject({ actorKind: "SERVICE", actorMembershipId: "m-svc" })
  })

  it("is SYSTEM with no tenant actor, and honours an explicit actor", async () => {
    const { service, appended } = serviceFor({ kind: "identity", userId: "u-1" })
    await service.record("o-1", [entry])
    await service.record("o-1", [entry], { kind: "member", membershipId: "m-new" })
    expect(appended.map((a) => a.rows[0]?.actorKind)).toEqual(["SYSTEM", "MEMBER"])
    expect(appended[1]?.rows[0]?.actorMembershipId).toBe("m-new")
  })
})

describe("nextMonth", () => {
  it("is the first instant of the next calendar month in UTC, across a year end", () => {
    expect(nextMonth(new Date("2026-01-31T23:00:00Z")).toISOString()).toBe("2026-02-01T00:00:00.000Z")
    expect(nextMonth(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })
})
