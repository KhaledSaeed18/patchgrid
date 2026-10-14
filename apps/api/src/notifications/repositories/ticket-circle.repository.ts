import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"
import type { Person, TicketCircle } from "../fan-out"

const PERSON = {
  id: true,
  userId: true,
  status: true,
  role: true,
  teams: { select: { teamId: true, isLead: true } },
} as const
type PersonRow = {
  id: string
  userId: string | null
  status: string
  role: Person["role"]
  teams: { teamId: string; isLead: boolean }[]
}

/** A human member, or nothing: a service account has no inbox (ADR-0021). */
const toPerson = (row: PersonRow | null): Person | null =>
  row === null || row.userId === null
    ? null
    : {
        membershipId: row.id,
        userId: row.userId,
        active: row.status === "ACTIVE",
        role: row.role,
        teamIds: row.teams.map((t) => t.teamId),
        leadOfTeamIds: row.teams.filter((t) => t.isLead).map((t) => t.teamId),
      }
const people = (rows: PersonRow[]): Person[] => rows.flatMap((r) => toPerson(r) ?? [])

/**
 * The people around one ticket, read when a `notify` job runs (DOMAIN.md §8):
 * its requester and assignee, its team and the team's leads, its explicit
 * watchers, the workspace's admins — each with the role and teams that decide
 * whether they may read it. Tenant-owned reads, each taking the org; a fixed
 * number of statements whatever the size of the circle.
 */
@Injectable()
export class TicketCircleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async load(orgId: string, ticketId: string, actorMembershipId: string | null): Promise<TicketCircle | null> {
    const ticket = await this.prisma.db.ticket.findUnique({
      where: { orgId_id: { orgId, id: ticketId } },
      select: {
        id: true,
        type: true,
        number: true,
        title: true,
        status: true,
        teamId: true,
        requesterMembershipId: true,
        assigneeMembershipId: true,
        requester: { select: PERSON },
        assignee: { select: PERSON },
        watchers: { select: { member: { select: PERSON } } },
      },
    })
    if (ticket === null) return null
    const requester = toPerson(ticket.requester)
    if (requester === null) return null

    const [org, team, admins, actor] = await Promise.all([
      this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { agentVisibility: true } }),
      ticket.teamId === null
        ? Promise.resolve([])
        : this.prisma.db.teamMembership.findMany({
            where: { orgId, teamId: ticket.teamId },
            select: { isLead: true, membership: { select: PERSON } },
          }),
      this.prisma.db.membership.findMany({
        where: { orgId, role: { in: ["ADMIN", "OWNER"] }, status: "ACTIVE", kind: "HUMAN" },
        select: PERSON,
      }),
      actorMembershipId === null
        ? Promise.resolve(null)
        : this.prisma.db.membership.findUnique({
            where: { orgId_id: { orgId, id: actorMembershipId } },
            select: { displayName: true },
          }),
    ])
    if (org === null) return null

    return {
      ticket: {
        id: ticket.id,
        type: ticket.type,
        number: ticket.number,
        title: ticket.title,
        status: ticket.status,
        teamId: ticket.teamId,
        requesterMembershipId: ticket.requesterMembershipId,
        assigneeMembershipId: ticket.assigneeMembershipId,
      },
      visibility: org.agentVisibility,
      requester,
      assignee: toPerson(ticket.assignee),
      teamMembers: people(team.map((t) => t.membership)),
      teamLeads: people(team.filter((t) => t.isLead).map((t) => t.membership)),
      watchers: people(ticket.watchers.map((w) => w.member)),
      admins: people(admins),
      actorName: actor?.displayName ?? null,
    }
  }
}
