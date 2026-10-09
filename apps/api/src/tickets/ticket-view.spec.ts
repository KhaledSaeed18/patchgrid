import { describe, expect, it } from "vitest"

import type { TicketSummaryRow } from "./repositories/ticket.repository"
import { toSummary } from "./ticket-view"

const NOW = new Date("2026-10-09T12:00:00Z")
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

function row(over: Partial<TicketSummaryRow> = {}): TicketSummaryRow {
  return {
    id: "t-1",
    number: 7,
    type: "INCIDENT",
    title: "Printer",
    status: "IN_PROGRESS",
    priority: "HIGH",
    respondBy: at(-30),
    resolveBy: at(120),
    respondedAt: null,
    resolvedAt: null,
    pausedAt: null,
    responseBreached: false,
    resolutionBreached: false,
    createdAt: at(-60),
    updatedAt: at(-60),
    requester: { id: "m-1", displayName: "Rita" },
    assignee: null,
    team: null,
    ...over,
  }
}

describe("toSummary's deadline", () => {
  it("is the response target until answered, then the resolution target", () => {
    expect(toSummary(row(), NOW).dueAt).toBe(at(-30).toISOString())
    expect(toSummary(row({ respondedAt: at(-40) }), NOW).dueAt).toBe(at(120).toISOString())
  })

  it("keeps a missed response as breached while the resolution still counts down", () => {
    const summary = toSummary(row({ respondedAt: at(-10), responseBreached: true }), NOW)
    expect(summary).toMatchObject({ dueAt: at(120).toISOString(), breached: true })
  })

  it("is gone once resolved or cancelled", () => {
    expect(toSummary(row({ resolvedAt: at(-5), status: "RESOLVED" }), NOW).dueAt).toBeNull()
    expect(toSummary(row({ status: "CANCELLED" }), NOW).dueAt).toBeNull()
  })

  it("is not breached while paused, even past due", () => {
    expect(toSummary(row({ respondedAt: at(-50), resolveBy: at(-1), pausedAt: at(-20) }), NOW).breached).toBe(false)
  })
})
