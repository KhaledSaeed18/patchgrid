import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import type { AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import type { Notifier } from "../../notifications/notify"
import type { PrismaService } from "../../prisma/prisma.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type { RunningClockRow, TicketRepository } from "../repositories/ticket.repository"
import { SlaScanService } from "./sla-scan"

const T0 = new Date("2026-10-09T08:00:00Z")
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const WARNINGS = { responseWarningMinutes: 10, resolutionWarningMinutes: 60 }

function clock(id: string, over: Partial<RunningClockRow> = {}): RunningClockRow {
  return {
    id,
    priority: "HIGH",
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
    slaPolicy: WARNINGS,
    ...over,
  }
}

function harness(pages: RunningClockRow[][], now: Date, lost: string[] = []) {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
  const queue = [...pages]
  const tickets = {
    findRunningClocks: vi.fn(async () => queue.shift() ?? []),
    flagSla: vi.fn(async (_o: string, id: string) => !lost.includes(id)),
  }
  const audit = { record: vi.fn(async () => undefined) }
  const notifier = { notifyAll: vi.fn(async () => undefined) }
  const service = new SlaScanService(
    tickets as unknown as TicketRepository,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    audit as unknown as AuditService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    notifier as unknown as Notifier,
    new FixedClock(now),
  )
  return { service, tickets, audit, notifier }
}

describe("SlaScanService", () => {
  it("flags what the clocks say and audits each flag as the system", async () => {
    const h = harness([[clock("warn"), clock("late", { respondBy: at(10) }), clock("fine", { respondBy: at(90) })]], at(21))
    expect(await h.service.scan()).toEqual([
      { ticketId: "warn", clock: "response", kind: "warning", due: at(30) },
      { ticketId: "late", clock: "response", kind: "breach", due: at(10) },
    ])
    expect(h.tickets.flagSla).toHaveBeenCalledWith("o-1", "late", "response", "breach", at(21))
    expect(h.audit.record).toHaveBeenCalledWith(
      "o-1",
      [{ action: "SLA_BREACHED", entityType: "Ticket", entityId: "late", diff: { clock: "response", due: at(10).toISOString() } }],
      { kind: "system" },
    )
    expect(h.notifier.notifyAll).toHaveBeenCalledTimes(1)
    expect(h.notifier.notifyAll).toHaveBeenCalledWith("o-1", [
      expect.objectContaining({ entityId: "warn", discriminator: `response-warning-${String(at(30).getTime())}` }),
      {
        event: { kind: "sla", ticketId: "late", actorMembershipId: null, clock: "response", signal: "breach" },
        entityId: "late",
        discriminator: `response-breach-${String(at(10).getTime())}`,
      },
    ])
  })

  it("audits nothing when another scan set the flag first", async () => {
    const h = harness([[clock("raced", { respondBy: at(10) })]], at(21), ["raced"])
    expect(await h.service.scan()).toEqual([])
    expect(h.audit.record).not.toHaveBeenCalled()
    expect(h.notifier.notifyAll).toHaveBeenCalledWith("o-1", [])
  })

  it("pages through a tenant by id", async () => {
    const full = Array.from({ length: 200 }, (_, i) => clock(`t-${String(i).padStart(3, "0")}`, { respondBy: at(500) }))
    const h = harness([full, []], at(21))
    await h.service.scan()
    expect(h.tickets.findRunningClocks).toHaveBeenNthCalledWith(2, "o-1", "t-199", 200)
  })
})
