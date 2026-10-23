import { Logger } from "@nestjs/common"
import type { UsageMetric } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../common/clock/clock"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { UsageSourceRepository } from "./repositories/usage-source.repository"
import { UsageReconcileService } from "./usage-reconcile"

const NOW = new Date("2026-10-23T12:00:00Z")

function harness(stored: Partial<Record<UsageMetric, bigint>>, counted: { seats: bigint; articles: bigint; storage: bigint; tickets: bigint; tokens?: bigint }) {
  const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  const order: string[] = []
  const set: Record<string, bigint> = {}
  const sources = {
    lockCounter: vi.fn(async (_o: string, period: string, metric: UsageMetric) => {
      order.push(`lock ${metric} ${period}`)
      return stored[metric] ?? 0n
    }),
    setCounter: vi.fn(async (_o: string, _p: string, metric: UsageMetric, value: bigint) => void (set[metric] = value)),
    seats: vi.fn(async () => (order.push("count seats"), counted.seats)),
    articles: vi.fn(async () => counted.articles),
    storageBytes: vi.fn(async () => counted.storage),
    apiTokens: vi.fn(async () => counted.tokens ?? 0n),
    ticketsCreated: vi.fn(async (_o: string, from: Date, to: Date) => {
      order.push(`tickets ${from.toISOString()}..${to.toISOString()}`)
      return counted.tickets
    }),
  }
  const service = new UsageReconcileService(
    sources as unknown as UsageSourceRepository,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    new FixedClock(NOW),
  )
  return { service, sources, set, order, warn }
}

describe("UsageReconcileService", () => {
  it("leaves counters that agree with their rows alone, and says nothing", async () => {
    const h = harness({ AGENT_SEATS: 3n, KB_ARTICLES: 4n, STORAGE_BYTES: 100n, TICKETS_CREATED: 7n }, { seats: 3n, articles: 4n, storage: 100n, tickets: 7n })
    const recounts = await h.service.reconcile()
    expect(recounts.every((r) => !r.repaired)).toBe(true)
    expect(h.sources.setCounter).not.toHaveBeenCalled()
    expect(h.warn).not.toHaveBeenCalled()
  })

  it("sets a drifted point-in-time counter to its count, locked before it counts", async () => {
    const h = harness({ AGENT_SEATS: 5n, KB_ARTICLES: 0n, STORAGE_BYTES: 999n, API_TOKENS: 9n }, { seats: 3n, articles: 2n, storage: 100n, tickets: 0n, tokens: 1n })
    await h.service.reconcile()
    expect(h.set).toEqual({ AGENT_SEATS: 3n, KB_ARTICLES: 2n, STORAGE_BYTES: 100n, API_TOKENS: 1n })
    expect(h.order.slice(0, 2)).toEqual(["lock AGENT_SEATS current", "count seats"])
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "usage counters drifted" }))
  })

  it("reports the month's ticket count but never rewrites it, counting this UTC month", async () => {
    const h = harness({ TICKETS_CREATED: 9n }, { seats: 0n, articles: 0n, storage: 0n, tickets: 7n })
    const recounts = await h.service.reconcile()
    expect(recounts.find((r) => r.metric === "TICKETS_CREATED")).toEqual({ metric: "TICKETS_CREATED", counted: 7n, stored: 9n, repaired: false })
    expect(h.set).not.toHaveProperty("TICKETS_CREATED")
    expect(h.order).toContain("tickets 2026-10-01T00:00:00.000Z..2026-11-01T00:00:00.000Z")
  })
})
