import { describe, expect, it } from "vitest"

import { createTicketRequestSchema, transitionRequestSchema, updateTicketRequestSchema } from "./tickets.ts"

const base = { type: "INCIDENT", title: "VPN drops", description: "Every hour", impact: "MEDIUM", urgency: "HIGH" }

describe("ticket requests", () => {
  it("refuse a priority from the client — it is computed (DOMAIN.md §3)", () => {
    expect(createTicketRequestSchema.safeParse(base).success).toBe(true)
    expect(createTicketRequestSchema.safeParse({ ...base, priority: "CRITICAL" }).success).toBe(false)
    expect(updateTicketRequestSchema.safeParse({ version: 1, priority: "LOW" }).success).toBe(false)
  })

  it("let a requester raise only incidents and service requests", () => {
    expect(createTicketRequestSchema.safeParse({ ...base, type: "CHANGE" }).success).toBe(false)
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
