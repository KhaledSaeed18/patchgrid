import { type Role, type TicketAction, ticketActionSchema, type TicketStatus } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { type ActorRelation, availableActions, type ChangeFacts, checkTransition, findRow, mayPerform } from "./transitions"

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
  const check = (
    status: TicketStatus,
    action: TicketAction,
    who: ActorRelation,
    comment: "PUBLIC" | "INTERNAL" | null = null,
    closedAt: Date | null = null,
  ) =>
    checkTransition({
      type: "INCIDENT",
      ticket: ticket(status, closedAt),
      action,
      actor: who,
      comment: comment === null ? null : { visibility: comment },
      now: NOW,
    })

  it("orders its refusals: not in the table, then not yours, then a guard, then the comment", () => {
    expect(check("CANCELLED", "reopen", actor("OWNER"))).toEqual({ ok: false, problem: "invalid-transition" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT"))).toEqual({ ok: false, problem: "not-permitted" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT", { isAssignee: true }))).toMatchObject({ ok: false, problem: "comment-required" })
    expect(check("IN_PROGRESS", "resolve", actor("AGENT", { isAssignee: true }), "PUBLIC")).toMatchObject({
      ok: true,
      row: { to: "RESOLVED" },
    })
  })

  it("wants the resolution note and the waiting reason in public, where the requester reads them", () => {
    expect(check("IN_PROGRESS", "wait", actor("ADMIN"), "INTERNAL")).toMatchObject({ problem: "comment-required" })
    expect(check("IN_PROGRESS", "wait", actor("ADMIN"), "PUBLIC")).toMatchObject({ ok: true })
  })

  it("cancels a new ticket without a reason, a worked one only with one", () => {
    expect(check("NEW", "cancel", actor("REQUESTER", { isRequester: true }))).toMatchObject({ ok: true })
    expect(check("IN_PROGRESS", "cancel", actor("REQUESTER", { isRequester: true }), "PUBLIC")).toEqual({
      ok: false,
      problem: "not-permitted",
    })
    expect(check("IN_PROGRESS", "cancel", actor("AGENT"))).toMatchObject({ problem: "comment-required" })
  })

  it("reopens a closed ticket within 30 days and not a minute after", () => {
    const requester = actor("REQUESTER", { isRequester: true })
    expect(check("CLOSED", "reopen", requester, null, new Date(NOW.getTime() - 30 * DAY))).toMatchObject({ ok: true })
    expect(check("CLOSED", "reopen", requester, null, new Date(NOW.getTime() - 30 * DAY - 60_000))).toMatchObject({
      ok: false,
      problem: "guard",
    })
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

/** DOMAIN.md §2.2 and §2.3, restated independently. */
const PROBLEM_LEGAL: Record<string, TicketStatus> = {
  "NEW:assign": "ASSIGNED",
  "NEW:start": "IN_PROGRESS",
  "ASSIGNED:start": "IN_PROGRESS",
  "IN_PROGRESS:workaround": "KNOWN_ERROR",
  "IN_PROGRESS:resolve": "RESOLVED",
  "KNOWN_ERROR:resolve": "RESOLVED",
  "RESOLVED:close": "CLOSED",
  "NEW:cancel": "CANCELLED",
  "ASSIGNED:cancel": "CANCELLED",
  "IN_PROGRESS:cancel": "CANCELLED",
  "KNOWN_ERROR:cancel": "CANCELLED",
}
const CHANGE_LEGAL: Record<string, TicketStatus> = {
  "DRAFT:submit": "AWAITING_APPROVAL",
  "AWAITING_APPROVAL:approve": "APPROVED",
  "AWAITING_APPROVAL:reject": "DRAFT",
  "APPROVED:start": "IN_PROGRESS",
  "IN_PROGRESS:complete": "IMPLEMENTED",
  "IN_PROGRESS:rollback": "ROLLED_BACK",
  "IMPLEMENTED:close": "CLOSED",
  "ROLLED_BACK:close": "CLOSED",
  "DRAFT:cancel": "CANCELLED",
  "AWAITING_APPROVAL:cancel": "CANCELLED",
  "APPROVED:cancel": "CANCELLED",
}
const ALL_STATUSES: TicketStatus[] = [
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
  "KNOWN_ERROR",
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "IMPLEMENTED",
  "ROLLED_BACK",
]

const plan: ChangeFacts = {
  plannedStart: new Date(NOW.getTime() + 3 * 3_600_000),
  plannedEnd: new Date(NOW.getTime() + 4 * 3_600_000),
  risk: "LOW",
  implementationPlan: "Swap it",
  rollbackPlan: "Swap it back",
  outcomeNotes: null,
}
const change = (status: TicketStatus, over: Partial<ChangeFacts> = {}) => ({ status, closedAt: null, change: { ...plan, ...over } })
const problem = (status: TicketStatus, over: { rootCause?: string | null; workaround?: string | null } = {}) => ({
  status,
  closedAt: null,
  problem: { rootCause: null, workaround: null, ...over },
})

describe.each([
  ["PROBLEM", PROBLEM_LEGAL],
  ["CHANGE", CHANGE_LEGAL],
] as const)("the %s transition table", (type, legal) => {
  it("has exactly the legal transitions, to the right status", () => {
    for (const status of ALL_STATUSES) {
      for (const action of ticketActionSchema.options) {
        expect(findRow(type, status, action)?.to, `${status}:${action}`).toBe(legal[`${status}:${action}`])
      }
    }
  })

  it("lets nothing leave CLOSED or CANCELLED", () => {
    for (const status of ["CLOSED", "CANCELLED"] as const) {
      for (const action of ticketActionSchema.options) expect(findRow(type, status, action)).toBeUndefined()
    }
  })
})

describe("problem guards", () => {
  const assignee = actor("AGENT", { isAssignee: true })
  const check = (t: ReturnType<typeof problem>, action: TicketAction, comment: { visibility: "PUBLIC" } | null = null) =>
    checkTransition({ type: "PROBLEM", ticket: t, action, actor: assignee, comment, now: NOW })

  it("wants a workaround for a known error and a root cause to resolve", () => {
    expect(check(problem("IN_PROGRESS"), "workaround")).toMatchObject({ ok: false, problem: "guard" })
    expect(check(problem("IN_PROGRESS", { workaround: "Restart it" }), "workaround")).toMatchObject({ ok: true })
    expect(check(problem("KNOWN_ERROR", { workaround: "Restart it", rootCause: "  " }), "resolve")).toMatchObject({
      ok: false,
      problem: "guard",
    })
    expect(check(problem("KNOWN_ERROR", { rootCause: "Leaky lease table" }), "resolve")).toMatchObject({ ok: true })
  })

  it("wants a reason to cancel, and offers resolve only once the root cause is written", () => {
    expect(check(problem("IN_PROGRESS"), "cancel")).toMatchObject({ ok: false, problem: "comment-required" })
    expect(availableActions({ type: "PROBLEM", ticket: problem("IN_PROGRESS"), actor: assignee, now: NOW })).not.toContain("resolve")
    expect(availableActions({ type: "PROBLEM", ticket: problem("IN_PROGRESS", { rootCause: "x" }), actor: assignee, now: NOW })).toContain(
      "resolve",
    )
  })

  it("never lets a requester move one", () => {
    expect(
      checkTransition({
        type: "PROBLEM",
        ticket: problem("NEW"),
        action: "cancel",
        actor: actor("REQUESTER", { isRequester: true }),
        comment: { visibility: "PUBLIC" },
        now: NOW,
      }),
    ).toMatchObject({ ok: false, problem: "not-permitted" })
  })
})

describe("change rules", () => {
  const owner = actor("AGENT", { isRequester: true })
  const run = (
    t: ReturnType<typeof change>,
    action: TicketAction,
    who: ActorRelation,
    extra: { comment?: { visibility: "PUBLIC" }; confirm?: boolean } = {},
  ) =>
    checkTransition({
      type: "CHANGE",
      ticket: t,
      action,
      actor: who,
      comment: extra.comment ?? null,
      now: NOW,
      ...(extra.confirm === undefined ? {} : { confirm: extra.confirm }),
    })

  it("submits only with the whole plan, naming what is missing", () => {
    expect(run(change("DRAFT"), "submit", owner)).toMatchObject({ ok: true })
    const missing = run(change("DRAFT", { rollbackPlan: null, risk: null }), "submit", owner)
    expect(missing).toMatchObject({ ok: false, problem: "guard" })
    if (!missing.ok && missing.problem === "guard") expect(missing.reason).toContain("rollbackPlan, risk")
  })

  it("lets the change's own requester or an admin submit and cancel — not another agent", () => {
    expect(run(change("DRAFT"), "submit", actor("AGENT"))).toMatchObject({ ok: false, problem: "not-permitted" })
    expect(run(change("DRAFT"), "submit", actor("ADMIN"))).toMatchObject({ ok: true })
    expect(run(change("APPROVED"), "cancel", owner)).toMatchObject({ ok: true })
  })

  it("decides by the service's standing: eligible approves or rejects; self only approves", () => {
    const eligible = actor("AGENT", { approval: "eligible" })
    const self = actor("OWNER", { isRequester: true, approval: "self" })
    const nobody = actor("ADMIN", { approval: "none" })
    expect(run(change("AWAITING_APPROVAL"), "approve", eligible)).toMatchObject({ ok: true })
    expect(run(change("AWAITING_APPROVAL"), "reject", eligible, { comment: { visibility: "PUBLIC" } })).toMatchObject({ ok: true })
    expect(run(change("AWAITING_APPROVAL"), "reject", eligible)).toMatchObject({ ok: false, problem: "comment-required" })
    expect(run(change("AWAITING_APPROVAL"), "approve", self)).toMatchObject({ ok: true })
    expect(run(change("AWAITING_APPROVAL"), "reject", self, { comment: { visibility: "PUBLIC" } })).toMatchObject({
      ok: false,
      problem: "not-permitted",
    })
    expect(run(change("AWAITING_APPROVAL"), "approve", nobody)).toMatchObject({ ok: false, problem: "not-permitted" })
    // The self-approving owner is also the change's requester, so may withdraw it too.
    expect(availableActions({ type: "CHANGE", ticket: change("AWAITING_APPROVAL"), actor: self, now: NOW })).toEqual(["approve", "cancel"])
  })

  it("asks for confirmation to start more than an hour early, and offers start regardless", () => {
    const assignee = actor("AGENT", { isAssignee: true })
    expect(run(change("APPROVED"), "start", assignee)).toMatchObject({ ok: false, problem: "confirm-required" })
    expect(run(change("APPROVED"), "start", assignee, { confirm: true })).toMatchObject({ ok: true })
    expect(run(change("APPROVED", { plannedStart: new Date(NOW.getTime() + 30 * 60_000) }), "start", assignee)).toMatchObject({ ok: true })
    expect(availableActions({ type: "CHANGE", ticket: change("APPROVED"), actor: assignee, now: NOW })).toContain("start")
  })

  it("closes the work only with outcome notes, either way it went", () => {
    const assignee = actor("AGENT", { isAssignee: true })
    expect(run(change("IN_PROGRESS"), "complete", assignee)).toMatchObject({ ok: false, problem: "guard" })
    expect(run(change("IN_PROGRESS", { outcomeNotes: "Done" }), "rollback", assignee)).toMatchObject({ ok: true })
  })
})
