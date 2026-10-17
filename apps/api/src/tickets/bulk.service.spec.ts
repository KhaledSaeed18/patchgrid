import { describe, expect, it, vi } from "vitest"

import type { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ConflictProblem, InvalidTransitionProblem, NotFoundProblem, NotPermittedProblem, StaleWriteProblem } from "../common/problems/problem.exception"
import type { StreamBus } from "../notifications/live/stream-bus"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { BulkTicketsService } from "./bulk.service"
import type { TicketsService } from "./tickets.service"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const OP = "0190b2f0-0000-7000-8000-0000000000aa"
const id = (n: number) => `0190b2f0-0000-7000-8000-${String(n).padStart(12, "0")}`

function harness(role: "AGENT" | "REQUESTER", fail: (ticketId: string) => Error | null = () => null) {
  const actor = { kind: "member", orgId: ORG, membershipId: "m-1", userId: "u-1", role, teamIds: [], leadOfTeamIds: [] }
  const tickets = {
    applyAssign: vi.fn(async (ticketId: string) => {
      const error = fail(ticketId)
      if (error !== null) throw error
    }),
    applyTransition: vi.fn(async (ticketId: string) => {
      const error = fail(ticketId)
      if (error !== null) throw error
    }),
  }
  const bus = { publish: vi.fn(async () => undefined) }
  const service = new BulkTicketsService(
    tickets as unknown as TicketsService,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    bus as unknown as StreamBus,
  )
  return { service, tickets, bus }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1), version: 1 }))

describe("BulkTicketsService", () => {
  it("runs the single action per ticket, and reports each ticket's own answer", async () => {
    const h = harness("AGENT", (ticketId) =>
      ticketId === id(2) ? new StaleWriteProblem() : ticketId === id(3) ? new NotFoundProblem() : ticketId === id(4) ? new InvalidTransitionProblem("CLOSED", "resolve") : null,
    )
    const result = await h.service.run({ operationId: OP, tickets: many(4), action: { kind: "transition", action: "resolve" } })
    expect(h.tickets.applyTransition).toHaveBeenCalledTimes(4)
    expect(result.done).toBe(1)
    expect(result.results.map((r) => r.outcome)).toEqual(["done", "conflict", "not-found", "refused"])
    expect(result.results[3]?.detail).toBeTruthy()
  })

  it("never lets one ticket's refusal stop the others", async () => {
    const h = harness("AGENT", (ticketId) => (ticketId === id(1) ? new NotPermittedProblem("no") : ticketId === id(2) ? new ConflictProblem("closed") : null))
    const result = await h.service.run({ operationId: OP, tickets: many(3), action: { kind: "assign", assigneeMembershipId: "m-2" } })
    expect(result.results.map((r) => r.outcome)).toEqual(["refused", "refused", "done"])
    expect(h.tickets.applyAssign).toHaveBeenLastCalledWith(id(3), { version: 1, assigneeMembershipId: "m-2" })
  })

  it("stops on a fault that is not a ticket's answer, as a single action would", async () => {
    const h = harness("AGENT", (ticketId) => (ticketId === id(2) ? new Error("database is down") : null))
    await expect(h.service.run({ operationId: OP, tickets: many(3), action: { kind: "transition", action: "close" } })).rejects.toThrow("database is down")
  })

  it("tells the acting member's stream every ten tickets and at the end", async () => {
    const h = harness("AGENT")
    await h.service.run({ operationId: OP, tickets: many(25), action: { kind: "transition", action: "close" } })
    const processed = h.bus.publish.mock.calls.map((call) => (call as unknown as [string, { membershipId: string; event: { processed: number } }])[1])
    expect(processed.map((m) => m.event.processed)).toEqual([10, 20, 25])
    expect(new Set(processed.map((m) => m.membershipId))).toEqual(new Set(["m-1"]))
  })

  it("is an agent's", async () => {
    const h = harness("REQUESTER")
    await expect(h.service.run({ operationId: OP, tickets: many(1), action: { kind: "transition", action: "close" } })).rejects.toBeInstanceOf(NotPermittedProblem)
    expect(h.tickets.applyTransition).not.toHaveBeenCalled()
  })
})
