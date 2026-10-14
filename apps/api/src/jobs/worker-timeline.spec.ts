import { Logger } from "@nestjs/common"
import type { Queue } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuditService } from "../audit/audit.service"
import { SystemClock } from "../common/clock/clock"
import type { AppConfig } from "../config/app-config"
import type { Notice, Notifier } from "../notifications/notify"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { RunningClockRow, TicketRepository } from "../tickets/repositories/ticket.repository"
import { AutoCloseService } from "../tickets/sweeps/auto-close"
import { SlaScanService } from "../tickets/sweeps/sla-scan"
import type { DispatchRepository } from "./dispatcher/repositories/dispatch.repository"
import { TenantDispatchService } from "./dispatcher/tenant-dispatch"
import { SWEEPS } from "./sweeps"

/**
 * The workers over time (ENGINEERING.md §Testing: worker tests on fake
 * timers). Each service runs on the real `SystemClock` while Vitest owns
 * time, so a day passes in a line and nothing sleeps. The repositories are
 * in-memory and honour the same conditions as the SQL they stand for.
 */
const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const MINUTE = 60_000
const T0 = new Date("2026-10-14T09:00:00.000Z")
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})
afterEach(() => vi.useRealTimers())

const inTransaction = { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService
const tenant = { requireOrgId: () => ORG } as unknown as TenantContextService
const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService
function notifier() {
  const sent: Notice[] = []
  return { sent, service: { notifyAll: vi.fn(async (_o: string, n: Notice[]) => void sent.push(...n)) } as unknown as Notifier }
}

describe("the dispatcher over time", () => {
  it("enqueues the same job ids within one interval and new ones in the next", async () => {
    const ids: string[][] = []
    const queue = { addBulk: vi.fn(async (jobs: { opts: { jobId: string } }[]) => void ids.push(jobs.map((j) => j.opts.jobId))) }
    const dispatch = new TenantDispatchService(
      { listDispatchable: async () => [{ id: ORG, plan: "FREE" }] } as unknown as DispatchRepository,
      new SystemClock(),
      { WORKER_MODE: "all" } as AppConfig,
      {} as Queue,
      queue as unknown as Queue,
      {} as Queue,
    )
    vi.setSystemTime(new Date(Math.ceil(T0.getTime() / MINUTE) * MINUTE))
    await dispatch.fanOut("sla-scan")
    vi.advanceTimersByTime(SWEEPS["sla-scan"].everyMs / 2)
    await dispatch.fanOut("sla-scan")
    vi.advanceTimersByTime(SWEEPS["sla-scan"].everyMs / 2)
    await dispatch.fanOut("sla-scan")
    expect(ids[0]).toEqual(ids[1])
    expect(ids[2]).not.toEqual(ids[0])
  })
})

describe("the SLA scan over a ticket's life", () => {
  /** One running ticket: response due at +30 with a 10-minute warning, resolution at +480 with 60. */
  function ticket(): RunningClockRow {
    return {
      id: "t-1",
      responseClockStartedAt: T0,
      resolutionClockStartedAt: T0,
      respondedAt: null,
      resolvedAt: null,
      pausedAt: null,
      respondBy: at(30),
      resolveBy: at(480),
      responseBreached: false,
      resolutionBreached: false,
      responseWarningSentAt: null,
      resolutionWarningSentAt: null,
      slaPolicy: { responseWarningMinutes: 10, resolutionWarningMinutes: 60 },
    }
  }

  function harness(row: RunningClockRow) {
    const tickets = {
      findRunningClocks: vi.fn(async (_o: string, after: string | null) => (after === null ? [row] : [])),
      // The conditional UPDATE: a flag is set once, and only on a clock still running.
      flagSla: vi.fn(async (_o: string, _id: string, clock: "response" | "resolution", kind: "warning" | "breach", now: Date) => {
        if (clock === "response") {
          if (row.respondedAt !== null || row.responseBreached) return false
          if (kind === "warning") {
            if (row.responseWarningSentAt !== null) return false
            row.responseWarningSentAt = now
          } else row.responseBreached = true
        } else {
          if (row.pausedAt !== null || row.resolutionBreached) return false
          if (kind === "warning") {
            if (row.resolutionWarningSentAt !== null) return false
            row.resolutionWarningSentAt = now
          } else row.resolutionBreached = true
        }
        return true
      }),
    }
    const told = notifier()
    const scan = new SlaScanService(tickets as unknown as TicketRepository, inTransaction, audit, tenant, told.service, new SystemClock())
    return { scan, told }
  }

  /** Runs the scan once a minute, as the dispatcher would, until `minutes` have passed. */
  async function runFor(h: ReturnType<typeof harness>, minutes: number) {
    const signals: string[] = []
    for (let m = 0; m < minutes; m += 1) {
      vi.advanceTimersByTime(MINUTE)
      for (const flag of await h.scan.scan()) signals.push(`${String(Math.round((Date.now() - T0.getTime()) / MINUTE))}:${flag.clock}-${flag.kind}`)
    }
    return signals
  }

  it("warns at the window and breaches at the target, each once, minute by minute", async () => {
    const h = harness(ticket())
    expect(await runFor(h, 600)).toEqual(["20:response-warning", "30:response-breach", "420:resolution-warning", "480:resolution-breach"])
    expect(h.told.sent.map((n) => n.discriminator)).toEqual([
      `response-warning-${String(at(30).getTime())}`,
      `response-breach-${String(at(30).getTime())}`,
      `resolution-warning-${String(at(480).getTime())}`,
      `resolution-breach-${String(at(480).getTime())}`,
    ])
  })

  it("stops the response clock when answered, and catches up at once after a long gap", async () => {
    const row = ticket()
    const h = harness(row)
    expect(await runFor(h, 25)).toEqual(["20:response-warning"])
    row.respondedAt = at(25)
    // The worker was down for hours: the next scan breaches the resolution clock, skipping its warning.
    vi.advanceTimersByTime(500 * MINUTE)
    expect((await h.scan.scan()).map((f) => `${f.clock}-${f.kind}`)).toEqual(["resolution-breach"])
  })
})

describe("auto-close over a week", () => {
  it("closes a resolved ticket seven days on, not a minute before, as the system", async () => {
    const resolved = [{ id: "t-1", version: 3, resolvedAt: T0 }]
    const closed: string[] = []
    const tickets = {
      findResolvedBefore: vi.fn(async (_o: string, cutoff: Date) => resolved.filter((t) => t.resolvedAt <= cutoff && !closed.includes(t.id))),
      updateVersioned: vi.fn(async (_o: string, id: string) => {
        closed.push(id)
        return true
      }),
    }
    const told = notifier()
    const sweep = new AutoCloseService(tickets as unknown as TicketRepository, inTransaction, audit, tenant, told.service, new SystemClock())
    vi.advanceTimersByTime(7 * 24 * 60 * MINUTE - MINUTE)
    expect(await sweep.closeExpired()).toBe(0)
    vi.advanceTimersByTime(MINUTE)
    expect(await sweep.closeExpired()).toBe(1)
    expect(await sweep.closeExpired()).toBe(0)
    expect(told.sent).toEqual([
      { event: { kind: "status-changed", ticketId: "t-1", actorMembershipId: null, to: "CLOSED", comment: null }, entityId: "t-1", discriminator: "v4" },
    ])
  })
})
