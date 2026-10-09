import { UnrecoverableError } from "bullmq"
import { describe, expect, it } from "vitest"

import { readTenantSweep, sweepPriority, sweepTick } from "./sweeps"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"

describe("sweep jobs", () => {
  it("are refused, never run, without the tenant they belong to", () => {
    expect(() => readTenantSweep({ id: "1", data: { tick: 3 } })).toThrow(UnrecoverableError)
    expect(() => readTenantSweep({ id: "1", data: { orgId: "acme", tick: 3 } })).toThrow(UnrecoverableError)
    expect(readTenantSweep({ id: "1", data: { orgId: ORG, tick: 3 } })).toEqual({ orgId: ORG, tick: 3 })
  })

  it("share a tick within one interval, so a repeated dispatch makes the same job ids", () => {
    const every = 60_000
    expect(sweepTick(new Date(120_000), every)).toBe(sweepTick(new Date(179_999), every))
    expect(sweepTick(new Date(180_000), every)).toBe(sweepTick(new Date(120_000), every) + 1)
  })

  it("run a paying tenant's sweep ahead of a free one's", () => {
    expect(sweepPriority("PRO")).toBeLessThan(sweepPriority("FREE"))
  })
})
