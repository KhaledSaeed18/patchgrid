import { type Role, type TicketAction, ticketActionSchema, type TicketStatus } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { type ActorRelation, availableActions, checkTransition, findRow, mayPerform } from "./transitions"

const NOW = new Date("2026-10-09T12:00:00Z")
const DAY = 86_400_000
const INCIDENT_STATUSES: TicketStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING", "RESOLVED", "CLOSED", "CANCELLED"]

/** DOMAIN.md §2.1, restated independently: every legal (from, action) → to. */
const LEGAL: Record<string, TicketStatus> = {
  "NEW:assign": "ASSIGNED",
  "NEW:start": "IN_PROGRESS",
  "ASSIGNED:start": "IN_PROGRESS",
  "IN_PROGRESS:wait": "PENDING",
  "PENDING:resume": "IN_PROGRESS",
  "IN_PROGRESS:resolve": "RESOLVED",
  "RESOLVED:close": "CLOSED",
  "RESOLVED:reopen": "IN_PROGRESS",
  "CLOSED:reopen": "IN_PROGRESS",
  "NEW:cancel": "CANCELLED",
  "ASSIGNED:cancel": "CANCELLED",
  "IN_PROGRESS:cancel": "CANCELLED",
  "PENDING:cancel": "CANCELLED",
}

const actor = (role: Role, over: Partial<ActorRelation> = {}): ActorRelation => ({
  role,
  isRequester: false,
  isAssignee: false,
  ticketHasAssignee: true,
  ...over,
})
const ticket = (status: TicketStatus, closedAt: Date | null = null) => ({ status, closedAt })

describe("the incident transition table", () => {
  it.each(["INCIDENT", "SERVICE_REQUEST"] as const)("%s: exactly the legal transitions exist, to the right status", (type) => {
    for (const status of INCIDENT_STATUSES) {
      for (const action of ticketActionSchema.options) {
        const row = findRow(type, status, action)
        expect(row?.to, `${status} --${action}-->`).toBe(LEGAL[`${status}:${action}`])
      }
    }
  })

  it("denies the deliberate denials (DOMAIN.md §2.1)", () => {
    expect(findRow("INCIDENT", "PENDING", "resolve")).toBeUndefined()
    expect(findRow("INCIDENT", "RESOLVED", "cancel")).toBeUndefined()
    expect(findRow("INCIDENT", "CLOSED", "cancel")).toBeUndefined()
    for (const action of ticketActionSchema.options) expect(findRow("INCIDENT", "CANCELLED", action)).toBeUndefined()
  })

  it("offers nothing for problems and changes until their tables land", () => {
    expect(findRow("PROBLEM", "NEW", "assign")).toBeUndefined()
    expect(findRow("CHANGE", "DRAFT", "submit")).toBeUndefined()
  })
})

describe("who may perform a transition", () => {
  it("assign: agents and above, never a requester", () => {
    expect(mayPerform("agent", actor("AGENT"))).toBe(true)
    expect(mayPerform("agent", actor("REQUESTER", { isRequester: true }))).toBe(false)
  })

  it("start: the assignee, any agent when nobody is assigned, an admin always", () => {
    expect(mayPerform("worker", actor("AGENT", { isAssignee: true }))).toBe(true)
    expect(mayPerform("worker", actor("AGENT", { ticketHasAssignee: false }))).toBe(true)
    expect(mayPerform("worker", actor("AGENT"))).toBe(false)
    expect(mayPerform("worker", actor("ADMIN"))).toBe(true)
  })

  it("wait, resume, resolve: the assignee or an admin", () => {
    expect(mayPerform("assignee_or_admin", actor("AGENT"))).toBe(false)
    expect(mayPerform("assignee_or_admin", actor("AGENT", { isAssignee: true }))).toBe(true)
    expect(mayPerform("assignee_or_admin", actor("OWNER"))).toBe(true)
    // A requester is never the assignee in practice; even if they were, they are not an agent.
    expect(mayPerform("assignee_or_admin", actor("REQUESTER", { isAssignee: true }))).toBe(false)
  })

  it("close, reopen, cancel-from-new: the ticket's own requester or an agent", () => {
    expect(mayPerform("requester_or_agent", actor("REQUESTER", { isRequester: true }))).toBe(true)
    expect(mayPerform("requester_or_agent", actor("REQUESTER"))).toBe(false)
    expect(mayPerform("requester_or_agent", actor("AGENT"))).toBe(true)
  })
})

describe("checkTransition", () => {
  const check = (status: TicketStatus, action: TicketAction, who: ActorRelation, comment: "PUBLIC" | "INTERNAL" | null = null, closedAt: Date | null = null) =>
    checkTransition({ type: "INCIDENT", ticket: ticket(status, closedAt), action, actor: who, comment: comment === null ? null : { visibility: comment }, now: NOW })

  it("orders its refusals: not in the table, then not yours, then a guard, then the comment", () => {
    expect(check("CANCELLED", "reopen", actor("OWNER"))).toEqual({ ok: false, problem: "invalid-transition" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT"))).toEqual({ ok: false, problem: "not-permitted" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT", { isAssignee: true }))).toMatchObject({ ok: false, problem: "comment-required" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT", { isAssignee: true }), "PUBLIC")).toMatchObject({ ok: true, row: { to: "RESOLVED" } })
  })

  it("wants the resolution note and the waiting reason in public, where the requester reads them", () => {
    expect(check("IN_PROGRESS", "wait", actor("ADMIN"), "INTERNAL")).toMatchObject({ problem: "comment-required" })
    expect(check("IN_PROGRESS", "wait", actor("ADMIN"), "PUBLIC")).toMatchObject({ ok: true })
  })

  it("cancels a new ticket without a reason, a worked one only with one", () => {
    expect(check("NEW", "cancel", actor("REQUESTER", { isRequester: true }))).toMatchObject({ ok: true })
    expect(check("IN_PROGRESS", "cancel", actor("REQUESTER", { isRequester: true }), "PUBLIC")).toEqual({ ok: false, problem: "not-permitted" })
    expect(check("IN_PROGRESS", "cancel", actor("AGENT"))).toMatchObject({ problem: "comment-required" })
  })

  it("reopens a closed ticket within 30 days and not a minute after", () => {
    const requester = actor("REQUESTER", { isRequester: true })
    expect(check("CLOSED", "reopen", requester, null, new Date(NOW.getTime() - 30 * DAY))).toMatchObject({ ok: true })
    expect(check("CLOSED", "reopen", requester, null, new Date(NOW.getTime() - 30 * DAY - 60_000))).toMatchObject({ ok: false, problem: "guard" })
  })
})

describe("availableActions — what the buttons are", () => {
  const offered = (status: TicketStatus, who: ActorRelation, closedAt: Date | null = null) =>
    availableActions({ type: "INCIDENT", ticket: ticket(status, closedAt), actor: who, now: NOW }).toSorted()

  it("gives a requester only what is theirs to do", () => {
    const own = actor("REQUESTER", { isRequester: true })
    expect(offered("NEW", own)).toEqual(["cancel"])
    expect(offered("IN_PROGRESS", own)).toEqual([])
    expect(offered("RESOLVED", own)).toEqual(["close", "reopen"])
    expect(offered("CLOSED", own, new Date(NOW.getTime() - 40 * DAY))).toEqual([])
  })

  it("gives the assignee the work, and a bystanding agent only what any agent may do", () => {
    expect(offered("IN_PROGRESS", actor("AGENT", { isAssignee: true }))).toEqual(["cancel", "resolve", "wait"])
    expect(offered("IN_PROGRESS", actor("AGENT"))).toEqual(["cancel"])
    expect(offered("NEW", actor("AGENT", { ticketHasAssignee: false }))).toEqual(["assign", "cancel", "start"])
  })

  it("offers nothing on a cancelled ticket, to anyone", () => {
    expect(offered("CANCELLED", actor("OWNER"))).toEqual([])
  })
})
