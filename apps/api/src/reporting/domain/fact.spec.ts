import { describe, expect, it } from "vitest"

import { type FactSource, factOf, sameFact } from "./fact"

const T0 = new Date("2026-10-17T09:00:00.000Z")
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

const ticket = (over: Partial<FactSource> = {}): FactSource => ({
  id: "t-1",
  version: 3,
  type: "INCIDENT",
  priority: "HIGH",
  teamId: "team-a",
  categoryId: null,
  assigneeMembershipId: "m-1",
  createdAt: T0,
  responseClockStartedAt: T0,
  resolutionClockStartedAt: T0,
  respondBy: at(60),
  resolveBy: at(480),
  respondedAt: null,
  resolvedAt: null,
  closedAt: null,
  cancelledAt: null,
  pausedMinutes: 0,
  responseBreached: false,
  resolutionBreached: false,
  reopenCount: 0,
  updatedAt: T0,
  ...over,
})

describe("factOf", () => {
  it("leaves a fresh ticket's clocks running, with no durations yet", () => {
    expect(factOf(ticket())).toMatchObject({ state: "OPEN", response: "RUNNING", resolution: "RUNNING", responseMinutes: null, resolutionMinutes: null })
  })

  it("meets a clock stopped in time, and breaches one stopped late even before the scan flagged it", () => {
    const f = factOf(ticket({ respondedAt: at(30), resolvedAt: at(500) }))
    expect(f).toMatchObject({ state: "RESOLVED", response: "MET", responseMinutes: 30, resolution: "BREACHED", resolutionMinutes: 500 })
  })

  it("takes the paused minutes off the time to resolve, as the clock does", () => {
    const f = factOf(ticket({ respondedAt: at(10), resolvedAt: at(600), pausedMinutes: 200, resolveBy: at(680) }))
    expect(f).toMatchObject({ resolutionMinutes: 400, resolution: "MET" })
  })

  it("breaches a running clock only once the scan flagged it: no 'now' in a fact", () => {
    expect(factOf(ticket({ responseBreached: true })).response).toBe("BREACHED")
    expect(factOf(ticket()).response).toBe("RUNNING")
  })

  it("counts a reopened ticket's resolution from its fresh start", () => {
    const f = factOf(ticket({ respondedAt: at(5), resolutionClockStartedAt: at(1_000), resolvedAt: at(1_090), resolveBy: at(1_480), reopenCount: 1 }))
    expect(f).toMatchObject({ resolutionMinutes: 90, resolution: "MET", reopenCount: 1 })
  })

  it("has no clock without a policy, and states from the lifecycle's times", () => {
    expect(factOf(ticket({ type: "PROBLEM", respondBy: null, resolveBy: null }))).toMatchObject({ response: "NONE", resolution: "NONE" })
    expect(factOf(ticket({ resolvedAt: at(10), closedAt: at(20) })).state).toBe("CLOSED")
    expect(factOf(ticket({ cancelledAt: at(5) })).state).toBe("CANCELLED")
  })

  it("is the same fact for the same ticket, and a different one when anything reported changes", () => {
    expect(sameFact(factOf(ticket()), factOf(ticket()))).toBe(true)
    expect(sameFact(factOf(ticket()), factOf(ticket({ teamId: "team-b" })))).toBe(false)
    expect(sameFact(factOf(ticket()), factOf(ticket({ version: 4 })))).toBe(false)
  })
})
