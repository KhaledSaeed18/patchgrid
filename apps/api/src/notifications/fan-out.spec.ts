import { describe, expect, it } from "vitest"

import { deliveriesFor, mailingsFor, type Person, reasonFor, type TicketCircle } from "./fan-out"

const ID = (n: number) => `0190b2f0-0000-7000-8000-${String(n).padStart(12, "0")}`
const person = (n: number, active = true): Person => ({
  membershipId: ID(n),
  userId: `u-${n}`,
  email: `p${n}@example.test`,
  emailPrefs: {},
  role: "AGENT",
  teamIds: [],
  leadOfTeamIds: [],
  active,
})
const REQ = person(1)
const AGENT = person(2)
const LEAD = person(3)
const WATCHER = person(4)
const ADMIN = person(5)
const TEAMMATE = person(6)
const TICKET = ID(99)

const circle = (over: Partial<TicketCircle> = {}): TicketCircle => ({
  ticket: {
    id: TICKET,
    type: "INCIDENT",
    number: 42,
    title: "Printer",
    status: "IN_PROGRESS",
    teamId: null,
    requesterMembershipId: ID(1),
    assigneeMembershipId: ID(2),
  },
  org: { name: "Acme", slug: "acme", visibility: "ALL_TICKETS", emailEnabled: true },
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

  it("a requester's own ticket confirms by email alone, and reaches the team in-app alone", () => {
    const out = deliveriesFor({ kind: "ticket-created", ticketId: TICKET, actorMembershipId: REQ.membershipId }, circle())
    expect(out.map((d) => d.type)).not.toContain("TICKET_RAISED_FOR_YOU")
    expect(out.find((d) => d.person === REQ)).toMatchObject({
      type: "TICKET_CREATED",
      title: "We've received INC-000042: Printer",
      channels: { inApp: false, email: true },
    })
    expect(out.filter((d) => d.person !== REQ).map((d) => d.channels)).toEqual([
      { inApp: true, email: false },
      { inApp: true, email: false },
      { inApp: true, email: false },
    ])
  })

  it("status changes the requester cares about, and only those", () => {
    const resolved = deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "RESOLVED", comment: null }, circle())
    expect(who(resolved)).toEqual([REQ, WATCHER].map((p) => p.membershipId).toSorted())
    const closedByRequester = deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: REQ.membershipId, to: "CLOSED", comment: null }, circle())
    // The assignee watches implicitly.
    expect(who(closedByRequester)).toEqual([AGENT, WATCHER].map((p) => p.membershipId).toSorted())
    expect(resolved[0]?.title).toBe("INC-000042 was resolved — Printer")
    expect(deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "IN_PROGRESS", comment: null }, circle())).toEqual([])
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

  it("a comment carried by a move reaches whoever the move does not, once each", () => {
    // Cancelled tells nobody by status; the required reason reaches the requester and watchers as a reply.
    const cancelled = deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "CANCELLED", comment: "PUBLIC" }, circle())
    expect(cancelled.map((d) => [d.person.membershipId, d.type])).toEqual([
      [REQ.membershipId, "COMMENT_PUBLIC"],
      [WATCHER.membershipId, "COMMENT_PUBLIC"],
    ])
    // Resolved: one row each — the status — not a second "new reply".
    const resolved = deliveriesFor({ kind: "status-changed", ticketId: TICKET, actorMembershipId: AGENT.membershipId, to: "RESOLVED", comment: "PUBLIC" }, circle())
    expect(resolved.map((d) => d.type)).toEqual(["STATUS_CHANGED", "STATUS_CHANGED"])
    // A reopen with a note: the assignee and lead hear the reopen; the note goes nowhere new.
    const reopened = deliveriesFor({ kind: "ticket-reopened", ticketId: TICKET, actorMembershipId: REQ.membershipId, comment: "PUBLIC" }, circle())
    expect(reopened.map((d) => [d.person.membershipId, d.type])).toEqual([
      [AGENT.membershipId, "TICKET_REOPENED"],
      [LEAD.membershipId, "TICKET_REOPENED"],
      [WATCHER.membershipId, "COMMENT_PUBLIC"],
    ])
  })
})

describe("who is also emailed (DOMAIN.md §8)", () => {
  const assigned = () =>
    deliveriesFor({ kind: "ticket-assigned", ticketId: TICKET, actorMembershipId: LEAD.membershipId, assigneeMembershipId: AGENT.membershipId }, circle())
  const row = (inserted: boolean) => new Map([[AGENT.membershipId, { id: ID(500), inserted }]])
  const EVENT = ID(900)

  it("emails a new inbox row, idempotent on the event and the person, saying why", () => {
    expect(mailingsFor(circle(), assigned(), row(true), EVENT)).toEqual([
      { person: AGENT, type: "TICKET_ASSIGNED", headline: "Assigned to you — INC-000042: Printer", reason: "this ticket is assigned to you", entityId: `${EVENT}-${AGENT.membershipId}` },
    ])
  })

  it("does not email a burst folded into an unread row", () => {
    expect(mailingsFor(circle(), assigned(), row(false), EVENT)).toEqual([])
  })

  it("respects the member's choice and the workspace's kill switch", () => {
    const muted = circle({ assignee: { ...AGENT, emailPrefs: { TICKET_ASSIGNED: false } } })
    const deliveries = deliveriesFor({ kind: "ticket-assigned", ticketId: TICKET, actorMembershipId: LEAD.membershipId, assigneeMembershipId: AGENT.membershipId }, muted)
    expect(mailingsFor(muted, deliveries, row(true), EVENT)).toEqual([])
    const off = circle({ org: { name: "Acme", slug: "acme", visibility: "ALL_TICKETS", emailEnabled: false } })
    expect(mailingsFor(off, assigned(), row(true), EVENT)).toEqual([])
  })

  it("emails a requester's confirmation once per event, and never the team", () => {
    const out = deliveriesFor({ kind: "ticket-created", ticketId: TICKET, actorMembershipId: REQ.membershipId }, circle())
    expect(mailingsFor(circle(), out, new Map(), EVENT)).toEqual([
      expect.objectContaining({ person: REQ, entityId: `${EVENT}-${REQ.membershipId}`, reason: "you raised this ticket" }),
    ])
  })

  it("names the closest tie as the reason", () => {
    expect(reasonFor(circle(), WATCHER.membershipId)).toBe("you're watching this ticket")
    expect(reasonFor(circle(), LEAD.membershipId)).toBe("you lead this ticket's team")
    expect(reasonFor(circle(), TEAMMATE.membershipId)).toBe("this ticket is in your team's queue")
    expect(reasonFor(circle(), ADMIN.membershipId)).toBe("you're an administrator of this workspace")
  })

  it("still tells everyone else when no person stands behind the requester", () => {
    const out = deliveriesFor({ kind: "sla", ticketId: TICKET, actorMembershipId: null, clock: "response", signal: "breach" }, circle({ requester: null }))
    expect(who(out)).toEqual([AGENT, LEAD, ADMIN].map((p) => p.membershipId).toSorted())
  })
})
