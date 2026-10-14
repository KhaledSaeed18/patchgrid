import { Logger } from "@nestjs/common"
import type { AgentVisibility, Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { MemberActor } from "../auth/actor"
import { TicketAudience } from "../notifications/audience"
import { NotificationStreamService } from "../notifications/live/notification-stream.service"
import type { StreamMessage } from "../notifications/live/stream-bus"
import type { TicketRow } from "../tickets/repositories/ticket.repository"
import { TicketRepository } from "../tickets/repositories/ticket.repository"
import { TicketAccess } from "../tickets/ticket-access"
import { PermissionService } from "./permission.service"

/**
 * ADR-0008 / RBAC.md §4: the stream's fan-out and the notification audience
 * decide "may this member read this ticket" exactly as opening it does. Every
 * role × visibility × relationship × team placement, against TicketAccess —
 * the decision a GET makes — so the two cannot drift.
 */
const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const ME = "0190b2f0-0000-7000-8000-000000000001"
const OTHER = "0190b2f0-0000-7000-8000-000000000002"
const MY_TEAM = "0190b2f0-0000-7000-8000-000000000050"
const THEIR_TEAM = "0190b2f0-0000-7000-8000-000000000051"
const TICKET = "0190b2f0-0000-7000-8000-000000000077"

const ROLES: Role[] = ["REQUESTER", "AGENT", "ADMIN", "OWNER"]
const VISIBILITY: AgentVisibility[] = ["OWN_TEAM_ONLY", "ALL_TICKETS"]
const RELATIONS = ["none", "requester", "assignee", "watcher"] as const
const PLACEMENT = { mine: MY_TEAM, theirs: THEIR_TEAM, none: null } as const

vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined)
const permissions = new PermissionService()
const audience = new TicketAudience(permissions)
const stream = new NotificationStreamService(
  {} as never,
  audience,
  {} as never,
  {} as never,
  permissions,
  {} as never,
  {} as never,
  {} as never,
)

const cases = ROLES.flatMap((role) =>
  VISIBILITY.flatMap((visibility) =>
    RELATIONS.flatMap((relation) =>
      (Object.keys(PLACEMENT) as (keyof typeof PLACEMENT)[]).map((placement) => ({ role, visibility, relation, placement })),
    ),
  ),
)

describe("the stream fan-out reads a ticket exactly as opening it does", () => {
  it.each(cases)("$role, $visibility, $relation, team $placement", async ({ role, visibility, relation, placement }) => {
    const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId: ME, role, teamIds: [MY_TEAM], leadOfTeamIds: [] }
    const teamId = PLACEMENT[placement]
    const row = {
      id: TICKET,
      type: "INCIDENT",
      status: "IN_PROGRESS",
      teamId,
      requesterMembershipId: relation === "requester" ? ME : OTHER,
      assigneeMembershipId: relation === "assignee" ? ME : null,
    } as TicketRow
    const watching = relation === "watcher"
    const repo = Object.create(TicketRepository.prototype) as TicketRepository
    repo.findById = async () => row
    repo.isWatching = async () => watching
    const opened = await new TicketAccess(repo, permissions).load(ORG, TICKET, actor, visibility).then(
      () => true,
      () => false,
    )

    const message: StreamMessage = {
      kind: "ticket-updated",
      ticket: {
        type: "INCIDENT",
        status: "IN_PROGRESS",
        teamId,
        requesterMembershipId: row.requesterMembershipId,
        assigneeMembershipId: row.assigneeMembershipId,
        watcherMembershipIds: watching ? [ME] : [],
      },
      visibility,
      content: "ticket",
      event: { ticketId: TICKET, updatedAt: new Date(0).toISOString() },
    }
    const reader = { membershipId: ME, userId: "u", role, teamIds: [MY_TEAM], leadOfTeamIds: [] }
    expect(stream.frameFor(ORG, reader, message) !== null).toBe(opened)
  })
})
