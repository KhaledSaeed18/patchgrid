import { describe, expect, it } from "vitest"

import { createTicketRequestSchema, ticketSearchQuerySchema, transitionRequestSchema, updateTicketRequestSchema } from "./tickets.ts"

const base = { type: "INCIDENT", title: "VPN drops", description: "Every hour", impact: "MEDIUM", urgency: "HIGH" }

describe("ticket requests", () => {
  it("refuse a priority from the client — it is computed (DOMAIN.md §3)", () => {
    expect(createTicketRequestSchema.safeParse(base).success).toBe(true)
    expect(createTicketRequestSchema.safeParse({ ...base, priority: "CRITICAL" }).success).toBe(false)
    expect(updateTicketRequestSchema.safeParse({ version: 1, priority: "LOW" }).success).toBe(false)
  })

  it("take every type — which a requester may raise is a permission, not a shape", () => {
    expect(createTicketRequestSchema.safeParse({ ...base, type: "CHANGE" }).success).toBe(true)
    expect(createTicketRequestSchema.safeParse({ ...base, type: "OTHER" }).success).toBe(false)
  })

  it("carry a Change's plan as optional fields, and refuse a link list that is empty or too long", () => {
    expect(
      createTicketRequestSchema.safeParse({ ...base, type: "CHANGE", change: { risk: "HIGH", plannedStart: "2026-10-20T08:00:00.000Z" } })
        .success,
    ).toBe(true)
    expect(createTicketRequestSchema.safeParse({ ...base, type: "PROBLEM", causedIncidentIds: [] }).success).toBe(false)
    expect(createTicketRequestSchema.safeParse({ ...base, type: "CHANGE", change: { risk: "EXTREME" } }).success).toBe(false)
  })

  it("want an update to carry its version and change something", () => {
    expect(updateTicketRequestSchema.safeParse({ title: "x" }).success).toBe(false)
    expect(updateTicketRequestSchema.safeParse({ version: 3 }).success).toBe(false)
    expect(updateTicketRequestSchema.safeParse({ version: 3, categoryId: null }).success).toBe(true)
  })

  it("accept a transition with its comment, and nothing a transition does not take", () => {
    expect(
      transitionRequestSchema.safeParse({ action: "wait", version: 2, comment: { body: "Need the serial", visibility: "PUBLIC" } }).success,
    ).toBe(true)
    expect(transitionRequestSchema.safeParse({ action: "wait", version: 2, status: "PENDING" }).success).toBe(false)
  })
})

describe("ticket search", () => {
  it("wants words to look for, and caps the results instead of paging them", () => {
    expect(ticketSearchQuerySchema.safeParse({ q: "   " }).success).toBe(false)
    expect(ticketSearchQuerySchema.parse({ q: " printer " })).toEqual({ q: "printer", limit: 25 })
    expect(ticketSearchQuerySchema.safeParse({ q: "printer", limit: "101" }).success).toBe(false)
    expect(ticketSearchQuerySchema.safeParse({ q: "printer", cursor: "x" }).success).toBe(false)
  })
})

describe("statuses by type", () => {
  it("cover every status, and call open exactly what comes before done", async () => {
    const { TICKET_STATUSES_BY_TYPE, OPEN_TICKET_STATUSES, ticketStatusSchema } = await import("./tickets.ts")
    const all = new Set(Object.values(TICKET_STATUSES_BY_TYPE).flat())
    expect([...all].toSorted()).toEqual([...ticketStatusSchema.options].toSorted())
    for (const done of ["RESOLVED", "CLOSED", "CANCELLED", "IMPLEMENTED", "ROLLED_BACK"] as const) {
      expect(OPEN_TICKET_STATUSES).not.toContain(done)
    }
  })
})
