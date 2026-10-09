import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import type { AuditService } from "../../audit/audit.service"
import { FixedClock } from "../../common/clock/clock"
import type { PrismaService } from "../../prisma/prisma.service"
import type { TenantContextService } from "../../tenancy/tenant-context.service"
import type { TicketRepository } from "../repositories/ticket.repository"
import { AutoCloseService } from "./auto-close"

const NOW = new Date("2026-10-09T12:00:00Z")

function harness(due: { id: string; version: number }[][], stale: string[] = []) {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
  const batches = [...due]
  const tickets = {
    findResolvedBefore: vi.fn(async () => batches.shift() ?? []),
    updateVersioned: vi.fn(async (_o: string, id: string) => !stale.includes(id)),
  }
  const audit = { record: vi.fn(async () => undefined) }
  const service = new AutoCloseService(
    tickets as unknown as TicketRepository,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    audit as unknown as AuditService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    new FixedClock(NOW),
  )
  return { service, tickets, audit }
}

describe("AutoCloseService", () => {
  it("closes what has been resolved for seven days, as the system, against each ticket's version", async () => {
    const h = harness([[{ id: "t-1", version: 4 }]])
    expect(await h.service.closeExpired()).toBe(1)
    expect(h.tickets.findResolvedBefore).toHaveBeenCalledWith("o-1", new Date("2026-10-02T12:00:00Z"), 100)
    expect(h.tickets.updateVersioned).toHaveBeenCalledWith("o-1", "t-1", 4, { status: "CLOSED", closedAt: NOW })
    expect(h.audit.record).toHaveBeenCalledWith(
      "o-1",
      [expect.objectContaining({ action: "TICKET_TRANSITIONED", diff: expect.objectContaining({ automatic: true }) })],
      { kind: "system" },
    )
  })

  it("skips a ticket someone reopened in the meantime, and audits nothing for it", async () => {
    const h = harness([[{ id: "t-1", version: 4 }, { id: "t-2", version: 1 }]], ["t-1"])
    expect(await h.service.closeExpired()).toBe(1)
    expect(h.audit.record).toHaveBeenCalledTimes(1)
  })

  it("keeps taking batches while they come back full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `t-${i}`, version: 1 }))
    const h = harness([full, [{ id: "t-last", version: 1 }]])
    expect(await h.service.closeExpired()).toBe(101)
    expect(h.tickets.findResolvedBefore).toHaveBeenCalledTimes(2)
  })
})
