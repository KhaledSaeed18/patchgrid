import { Logger } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { PermissionService } from "../authz/permission.service"
import { type AudienceTicket, type Reader, TicketAudience } from "./audience"

const ORG = "0190b2f0-0000-7000-8000-000000000000"
const NET = "team-network"
const SEC = "team-security"

const reader = (membershipId: string, role: Reader["role"], teamIds: string[] = []): Reader => ({
  membershipId,
  userId: `u-${membershipId}`,
  role,
  teamIds,
  leadOfTeamIds: [],
})
const ticket = (over: Partial<AudienceTicket> = {}): AudienceTicket => ({
  type: "INCIDENT",
  status: "IN_PROGRESS",
  teamId: NET,
  requesterMembershipId: "m-req",
  assigneeMembershipId: "m-agent",
  watcherMembershipIds: new Set(),
  ...over,
})

vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
const audience = new TicketAudience(new PermissionService())

describe("who may hear about a ticket (DOMAIN.md §8)", () => {
  it("the requester reads their own ticket, but never its internal notes", () => {
    expect(audience.mayRead(ORG, reader("m-req", "REQUESTER"), ticket(), "OWN_TEAM_ONLY")).toBe(true)
    expect(audience.mayRead(ORG, reader("m-req", "REQUESTER"), ticket(), "OWN_TEAM_ONLY", "internal")).toBe(false)
  })

  it("a requester watching reads the ticket; one merely on its team does not", () => {
    const watched = ticket({ watcherMembershipIds: new Set(["m-other"]) })
    expect(audience.mayRead(ORG, reader("m-other", "REQUESTER"), watched, "ALL_TICKETS")).toBe(true)
    expect(audience.mayRead(ORG, reader("m-other", "REQUESTER", [NET]), ticket(), "ALL_TICKETS")).toBe(false)
  })

  it("an assignee since demoted to requester hears nothing more", () => {
    expect(audience.mayRead(ORG, reader("m-agent", "AGENT"), ticket(), "OWN_TEAM_ONLY", "internal")).toBe(true)
    expect(audience.mayRead(ORG, reader("m-agent", "REQUESTER"), ticket(), "OWN_TEAM_ONLY")).toBe(false)
  })

  it("an own-team agent reads their team's tickets, unteamed ones and their own, and nothing else", () => {
    const sec = reader("m-sec", "AGENT", [SEC])
    expect(audience.mayRead(ORG, sec, ticket(), "OWN_TEAM_ONLY")).toBe(false)
    expect(audience.mayRead(ORG, sec, ticket({ teamId: SEC }), "OWN_TEAM_ONLY")).toBe(true)
    expect(audience.mayRead(ORG, sec, ticket({ teamId: null }), "OWN_TEAM_ONLY")).toBe(true)
    expect(audience.mayRead(ORG, sec, ticket({ assigneeMembershipId: "m-sec" }), "OWN_TEAM_ONLY")).toBe(true)
    expect(audience.mayRead(ORG, sec, ticket({ watcherMembershipIds: new Set(["m-sec"]) }), "OWN_TEAM_ONLY", "internal")).toBe(true)
    expect(audience.mayRead(ORG, sec, ticket(), "ALL_TICKETS")).toBe(true)
  })

  it("admins read everything", () => {
    expect(audience.mayRead(ORG, reader("m-admin", "ADMIN"), ticket(), "OWN_TEAM_ONLY", "internal")).toBe(true)
  })
})
