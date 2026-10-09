import { describe, expect, it } from "vitest"

import { deliveriesFor, type Person, type TicketCircle } from "./fan-out"

const ID = (n: number) => `0190b2f0-0000-7000-8000-${String(n).padStart(12, "0")}`
const person = (n: number, active = true): Person => ({ membershipId: ID(n), userId: `u-${n}`, active })
const REQ = person(1)
const AGENT = person(2)
const LEAD = person(3)
const WATCHER = person(4)
const ADMIN = person(5)
const TEAMMATE = person(6)
const TICKET = ID(99)

const circle = (over: Partial<TicketCircle> = {}): TicketCircle => ({
  ticket: { id: TICKET, type: "INCIDENT", number: 42, title: "Printer", status: "IN_PROGRESS" },
  requester: REQ,
  assignee: AGENT,
  teamMembers: [LEAD, TEAMMATE, AGENT],
  teamLeads: [LEAD],
  watchers: [WATCHER],
  admins: [ADMIN],
  actorName: "Sam",
  ...over,
})
const who = (deliveries: ReturnType<typeof deliveriesFor>) => deliveries.map((d) => d.person.membershipId).toSorted()

describe("who hears about what (DOMAIN.md §8)", () => {
  it("a public reply: requester, assignee and watchers, never its author, collapsed per ticket", () => {
    const out = deliveriesFor({ kind: "comment-added", ticketId: TICKET, actorMembershipId: AGENT.membershipId, visibility: "PUBLIC" }, circle())
    expect(who(out)).toEqual([REQ, WATCHER].map((p) => p.membershipId).toSorted())
    expect(out[0]).toMatchObject({ type: "COMMENT_PUBLIC", title: "New reply on INC-000042: Printer", dedupeKey: `comment:${TICKET}` })
  })

  it("an internal note reaches the assignee alone — never a watcher", () => {
    const out = deliveriesFor({ kind: "comment-added", ticketId: TICKET, actorMembershipId: LEAD.membershipId, visibility: "INTERNAL" }, circle())
    expect(who(out)).toEqual([AGENT.membershipId])
  })

  it("a ticket raised on someone's behalf tells them by name, and the team in-app", () => {
    const out = deliveriesFor({ kind: "ticket-created", ticketId: TICKET, actorMembershipId: AGENT.membershipId }, circle())
    expect(out.find((d) => d.person === REQ)).toMatchObject({ type: "TICKET_RAISED_FOR_YOU", title: "Sam raised INC-000042: Printer for you" })
    expect(who(out)).toEqual([REQ, LEAD, TEAMMATE].map((p) => p.membershipId).toSorted())
  })

  it("a requester's own ticket does not notify them", () => {
    const out = deliveriesFor({ kind: "ticket-created", ticketId: TICKET, actorMembershipId: REQ.membershipId }, circle())
    expect(out.map((d) => d.type)).not.toContain("TICKET_RAISED_FOR_YOU")
  })

  it("status changes the requester cares about, and only those", () => {
    const resolved = deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "RESOLVED" }, circle())
    expect(who(resolved)).toEqual([REQ, WATCHER].map((p) => p.membershipId).toSorted())
    expect(resolved[0]?.title).toBe("INC-000042 was resolved — Printer")
    expect(deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "IN_PROGRESS" }, circle())).toEqual([])
  })

  it("a breach reaches the assignee, the team lead and every admin; a warning only the first two", () => {
    const warn = deliveriesFor({ kind: "sla", ticketId: TICKET, actorMembershipId: null, clock: "response", signal: "warning" }, circle())
    const breach = deliveriesFor({ kind: "sla", ticketId: TICKET, actorMembershipId: null, clock: "response", signal: "breach" }, circle())
    expect(who(warn)).toEqual([AGENT, LEAD].map((p) => p.membershipId).toSorted())
    expect(who(breach)).toEqual([AGENT, LEAD, ADMIN].map((p) => p.membershipId).toSorted())
  })

  it("skips a member who has since left, and names the assignee only if still assigned", () => {
    const gone = deliveriesFor({ kind: "comment-added", ticketId: TICKET, actorMembershipId: AGENT.membershipId, visibility: "PUBLIC" }, circle({ requester: person(1, false) }))
    expect(who(gone)).toEqual([WATCHER.membershipId])
    const reassigned = deliveriesFor({ kind: "ticket-assigned", ticketId: TICKET, actorMembershipId: LEAD.membershipId, assigneeMembershipId: TEAMMATE.membershipId }, circle())
    expect(reassigned).toEqual([])
  })
})
