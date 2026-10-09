import { Logger } from "@nestjs/common"
import type { Plan, UsageMetric } from "@patchgrid/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FixedClock } from "../common/clock/clock"
import { PlanLimitProblem } from "../common/problems/problem.exception"
import { holdsSeat, QuotaService } from "./quota.service"
import type { UsageCounterRepository } from "./repositories/usage-counter.repository"

/** An in-memory counter table that applies the same conditional writes the SQL does. */
function harness(plan: Plan, start: Partial<Record<string, bigint>> = {}) {
  const values = new Map<string, bigint>(Object.entries(start).map(([k, v]) => [k, v ?? 0n]))
  const key = (period: string, metric: UsageMetric) => `${metric}@${period}`
  const repo = {
    planOf: async () => plan,
    ensure: async (_o: string, period: string, metric: UsageMetric) => {
      if (!values.has(key(period, metric))) values.set(key(period, metric), 0n)
    },
    increment: async (_o: string, period: string, metric: UsageMetric, n: number, limit: number | null) => {
      const current = values.get(key(period, metric)) ?? 0n
      if (limit !== null && current + BigInt(n) > BigInt(limit)) return false
      values.set(key(period, metric), current + BigInt(n))
      return true
    },
    decrement: async (_o: string, period: string, metric: UsageMetric, n: number) => {
      const current = values.get(key(period, metric)) ?? 0n
      if (current < BigInt(n)) {
        values.set(key(period, metric), 0n)
        return "floored" as const
      }
      values.set(key(period, metric), current - BigInt(n))
      return "applied" as const
    },
    read: async (_o: string, period: string, metric: UsageMetric) => values.get(key(period, metric)) ?? 0n,
    list: async () => [...values].map(([k, value]) => {
      const [metric, period] = k.split("@") as [UsageMetric, string]
      return { metric, period, value }
    }),
  }
  const service = new QuotaService(repo as unknown as UsageCounterRepository, new FixedClock(new Date("2026-10-09T12:00:00Z")))
  return { service, values }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
})

describe("QuotaService", () => {
  it("consumes up to the plan limit and refuses the unit after it with a 402", async () => {
    const { service, values } = harness("FREE", { "AGENT_SEATS@current": 2n })
    await service.consume("o-1", "AGENT_SEATS")
    await expect(service.consume("o-1", "AGENT_SEATS")).rejects.toBeInstanceOf(PlanLimitProblem)
    expect(values.get("AGENT_SEATS@current")).toBe(3n)
  })

  it("counts tickets per UTC month, and treats an unlimited metric as unlimited", async () => {
    const { service, values } = harness("PRO")
    await service.consume("o-1", "TICKETS_CREATED")
    await service.consume("o-1", "KB_ARTICLES", 1000)
    expect(values.get("TICKETS_CREATED@2026-10")).toBe(1n)
    expect(values.get("KB_ARTICLES@current")).toBe(1000n)
  })

  it("releases, and floors a drifted counter at zero with a logged error", async () => {
    const { service, values } = harness("FREE", { "AGENT_SEATS@current": 1n })
    await service.release("o-1", "AGENT_SEATS")
    expect(values.get("AGENT_SEATS@current")).toBe(0n)
    await service.release("o-1", "AGENT_SEATS")
    expect(values.get("AGENT_SEATS@current")).toBe(0n)
    expect(Logger.prototype.error).toHaveBeenCalledOnce()
  })

  it("answers hasRoom without consuming", async () => {
    const { service, values } = harness("FREE", { "AGENT_SEATS@current": 3n })
    expect(await service.hasRoom("o-1", "AGENT_SEATS")).toBe(false)
    expect(await service.hasRoom("o-1", "AUTOMATION_RULES")).toBe(true)
    expect(values.get("AGENT_SEATS@current")).toBe(3n)
  })

  it("reports every metric with its period and limit, zero where nothing was counted yet", async () => {
    const usage = await harness("FREE", { "AGENT_SEATS@current": 2n }).service.usage("o-1")
    expect(usage.plan).toBe("FREE")
    expect(usage.metrics.find((m) => m.metric === "AGENT_SEATS")).toEqual({ metric: "AGENT_SEATS", period: "current", used: 2, limit: 3 })
    expect(usage.metrics.find((m) => m.metric === "TICKETS_CREATED")).toEqual({ metric: "TICKETS_CREATED", period: "2026-10", used: 0, limit: 200 })
  })
})

describe("holdsSeat", () => {
  it("is an active human at agent or above — nothing else", () => {
    expect(holdsSeat({ role: "AGENT", status: "ACTIVE", kind: "HUMAN" })).toBe(true)
    expect(holdsSeat({ role: "OWNER", status: "ACTIVE", kind: "HUMAN" })).toBe(true)
    expect(holdsSeat({ role: "REQUESTER", status: "ACTIVE", kind: "HUMAN" })).toBe(false)
    expect(holdsSeat({ role: "AGENT", status: "DISABLED", kind: "HUMAN" })).toBe(false)
    expect(holdsSeat({ role: "AGENT", status: "ACTIVE", kind: "SERVICE_ACCOUNT" })).toBe(false)
  })
})
