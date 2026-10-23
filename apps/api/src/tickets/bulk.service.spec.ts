import { describe, expect, it, vi } from "vitest"

import type { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import {
  ConflictProblem,
  InvalidTransitionProblem,
  NotFoundProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import type { RedisService } from "../redis/redis.service"
import type { StreamBus } from "../notifications/live/stream-bus"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { BulkTicketsService } from "./bulk.service"
import type { TicketsService } from "./tickets.service"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const OP = "0190b2f0-0000-7000-8000-0000000000aa"
const id = (n: number) => `0190b2f0-0000-7000-8000-${String(n).padStart(12, "0")}`

function harness(role: "AGENT" | "REQUESTER", fail: (ticketId: string) => Error | null = () => null, running = false) {
  const actor = { kind: "member", orgId: ORG, membershipId: "m-1", userId: "u-1", role, teamIds: [], leadOfTeamIds: [] }
  const leases = new Set<string>(running ? ["bulk:running:m-1"] : [])
  const redis = {
    client: {
      set: vi.fn(async (key: string) => (leases.has(key) ? null : (leases.add(key), "OK"))),
      del: vi.fn(async (key: string) => Number(leases.delete(key))),
    },
  }
  const tickets = {
    checkAssignment: vi.fn(async () => undefined),
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
    redis as unknown as RedisService,
  )
  return { service, tickets, bus, leases }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1), version: 1 }))

describe("BulkTicketsService", () => {
  it("runs the single action per ticket, and reports each ticket's own answer", async () => {
    const h = harness("AGENT", (ticketId) =>
      ticketId === id(2)
        ? new StaleWriteProblem()
        : ticketId === id(3)
          ? new NotFoundProblem()
          : ticketId === id(4)
            ? new InvalidTransitionProblem("CLOSED", "resolve")
            : null,
    )
    const result = await h.service.run({ operationId: OP, tickets: many(4), action: { kind: "transition", action: "resolve" } })
    expect(h.tickets.applyTransition).toHaveBeenCalledTimes(4)
    expect(result.done).toBe(1)
    expect(result.results.map((r) => r.outcome)).toEqual(["done", "conflict", "not-found", "refused"])
    expect(result.results[3]?.detail).toBeTruthy()
  })

  it("never lets one ticket's refusal stop the others", async () => {
    const h = harness("AGENT", (ticketId) =>
      ticketId === id(1) ? new NotPermittedProblem("no") : ticketId === id(2) ? new ConflictProblem("closed") : null,
    )
    const result = await h.service.run({ operationId: OP, tickets: many(3), action: { kind: "assign", assigneeMembershipId: "m-2" } })
    expect(result.results.map((r) => r.outcome)).toEqual(["refused", "refused", "done"])
    expect(h.tickets.applyAssign).toHaveBeenLastCalledWith(id(3), { version: 1, assigneeMembershipId: "m-2" })
  })

  it("reports a fault on one ticket as failed and carries on, so no result is lost to a 500", async () => {
    const h = harness("AGENT", (ticketId) => (ticketId === id(2) ? new Error("connection reset") : null))
    const result = await h.service.run({ operationId: OP, tickets: many(3), action: { kind: "transition", action: "close" } })
    expect(result.results.map((r) => r.outcome)).toEqual(["done", "failed", "done"])
    expect(result.results[1]?.detail).not.toContain("connection")
  })

  it("keeps the field's own reason when a ticket's action fails validation", async () => {
    const h = harness(
      "AGENT",
      () => new ValidationProblem([{ path: "comment", message: "A public reply is required to resolve", code: "comment_required" }]),
    )
    const result = await h.service.run({ operationId: OP, tickets: many(1), action: { kind: "transition", action: "resolve" } })
    expect(result.results[0]).toMatchObject({ outcome: "refused", detail: "A public reply is required to resolve" })
  })

  it("lets one member run one bulk action at a time, and frees the lease when it ends", async () => {
    const busy = harness("AGENT", () => null, true)
    await expect(
      busy.service.run({ operationId: OP, tickets: many(1), action: { kind: "transition", action: "close" } }),
    ).rejects.toBeInstanceOf(ConflictProblem)
    const h = harness("AGENT")
    await h.service.run({ operationId: OP, tickets: many(1), action: { kind: "transition", action: "close" } })
    expect(h.leases.size).toBe(0)
  })

  it("checks an assignment once, before any ticket", async () => {
    const h = harness("AGENT")
    h.tickets.checkAssignment.mockRejectedValueOnce(
      new ValidationProblem([{ path: "assigneeMembershipId", message: "is not an active agent", code: "x" }]),
    )
    await expect(
      h.service.run({ operationId: OP, tickets: many(3), action: { kind: "assign", assigneeMembershipId: "m-x" } }),
    ).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.tickets.applyAssign).not.toHaveBeenCalled()
  })

  it("tells the acting member's stream every ten tickets and at the end", async () => {
    const h = harness("AGENT")
    await h.service.run({ operationId: OP, tickets: many(25), action: { kind: "transition", action: "close" } })
    const processed = h.bus.publish.mock.calls.map(
      (call) => (call as unknown as [string, { membershipId: string; event: { processed: number } }])[1],
    )
    expect(processed.map((m) => m.event.processed)).toEqual([10, 20, 25])
    expect(new Set(processed.map((m) => m.membershipId))).toEqual(new Set(["m-1"]))
  })

  it("is an agent's", async () => {
    const h = harness("REQUESTER")
    await expect(
      h.service.run({ operationId: OP, tickets: many(1), action: { kind: "transition", action: "close" } }),
    ).rejects.toBeInstanceOf(NotPermittedProblem)
    expect(h.tickets.applyTransition).not.toHaveBeenCalled()
  })
})
