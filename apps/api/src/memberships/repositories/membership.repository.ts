import { Injectable } from "@nestjs/common"
import type { MembershipKind, MembershipStatus, Role } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/** A membership with the team facts the `Actor` carries (RBAC.md §11). */
export type MembershipRecord = {
  id: string
  orgId: string
  userId: string | null
  role: Role
  status: MembershipStatus
  kind: MembershipKind
  displayName: string
  teamIds: string[]
  leadOfTeamIds: string[]
}

/** A row of the member list, with contact details when the caller may see them. */
export type MemberRow = {
  id: string
  userId: string | null
  displayName: string
  avatarUrl: string | null
  role: Role
  status: MembershipStatus
  kind: MembershipKind
  joinedAt: Date | null
  createdAt: Date
  teams: { id: string; name: string; isLead: boolean }[]
  contact: { email: string | null; lastLoginAt: Date | null } | null
}

export type MemberListQuery = {
  includeRemoved: boolean
  withContact: boolean
  limit: number
  /** Keyset: strictly after this `(createdAt, id)`. */
  after: { createdAt: Date; id: string } | null
}

const RECORD = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
  status: true,
  kind: true,
  displayName: true,
  teams: { select: { teamId: true, isLead: true } },
} as const

const memberSelect = (withContact: boolean) =>
  ({
    id: true,
    userId: true,
    displayName: true,
    avatarUrl: true,
    role: true,
    status: true,
    kind: true,
    joinedAt: true,
    createdAt: true,
    teams: { select: { isLead: true, team: { select: { id: true, name: true } } } },
    user: withContact ? { select: { email: true, lastLoginAt: true } } : false,
  }) as const

/**
 * The first tenant-owned repository. Every method takes an explicit `orgId`
 * and filters on it — isolation layer 2 — even though the client extension
 * and RLS underneath would each catch a mistake on their own (TENANCY.md §7).
 * Writes go through `prisma.db`, so inside `transaction()` they join it.
 */
@Injectable()
export class MembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(orgId: string, userId: string): Promise<MembershipRecord | null> {
    const row = await this.prisma.db.membership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: RECORD,
    })
    return row === null ? null : toRecord(row)
  }

  async findById(orgId: string, id: string): Promise<MembershipRecord | null> {
    const row = await this.prisma.db.membership.findUnique({
      where: { orgId_id: { orgId, id } },
      select: RECORD,
    })
    return row === null ? null : toRecord(row)
  }

  /** The membership of the account with this address, if it ever joined. */
  async findByEmail(orgId: string, email: string): Promise<MembershipRecord | null> {
    const row = await this.prisma.db.membership.findFirst({
      where: { orgId, user: { email } },
      select: RECORD,
    })
    return row === null ? null : toRecord(row)
  }

  /** Oldest first — join order, which is stable and what an admin expects to page through. */
  async list(orgId: string, query: MemberListQuery): Promise<MemberRow[]> {
    const rows = await this.prisma.db.membership.findMany({
      where: {
        orgId,
        ...(query.includeRemoved ? {} : { status: { not: "REMOVED" } }),
        ...(query.after === null
          ? {}
          : {
              OR: [
                { createdAt: { gt: query.after.createdAt } },
                { createdAt: query.after.createdAt, id: { gt: query.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: query.limit,
      select: memberSelect(query.withContact),
    })
    return rows.map((row) => toMemberRow(row, query.withContact))
  }

  async findMember(orgId: string, id: string, withContact: boolean): Promise<MemberRow | null> {
    const row = await this.prisma.db.membership.findUnique({
      where: { orgId_id: { orgId, id } },
      select: memberSelect(withContact),
    })
    return row === null ? null : toMemberRow(row, withContact)
  }

  /**
   * The row lock every "how many are there" invariant takes first (TENANCY.md
   * §8): two owners demoting each other serialise here, and the second sees
   * the first's commit. Must run inside `transaction()`.
   */
  async lockOrganization(orgId: string): Promise<void> {
    await this.prisma.db.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`
  }

  countActiveOwners(orgId: string): Promise<number> {
    return this.prisma.db.membership.count({ where: { orgId, role: "OWNER", status: "ACTIVE" } })
  }

  async setRole(orgId: string, id: string, role: Role): Promise<void> {
    await this.prisma.db.membership.update({ where: { orgId_id: { orgId, id } }, data: { role } })
  }

  async setStatus(orgId: string, id: string, status: MembershipStatus): Promise<void> {
    await this.prisma.db.membership.update({ where: { orgId_id: { orgId, id } }, data: { status } })
  }

  /** Every team the membership is in; returns the ids it left. */
  async leaveAllTeams(orgId: string, membershipId: string): Promise<string[]> {
    const teams = await this.prisma.db.teamMembership.findMany({
      where: { orgId, membershipId },
      select: { teamId: true },
    })
    await this.prisma.db.teamMembership.deleteMany({ where: { orgId, membershipId } })
    return teams.map((t) => t.teamId)
  }

  async create(
    orgId: string,
    data: {
      userId: string
      role: Role
      displayName: string
      invitedByMembershipId: string
      joinedAt: Date
    },
  ): Promise<string> {
    const row = await this.prisma.db.membership.create({
      data: { orgId, ...data, status: "ACTIVE", kind: "HUMAN" },
      select: { id: true },
    })
    return row.id
  }

  /** A removed member comes back as the same row, so history keeps one author (ADR-0033). */
  async reactivate(
    orgId: string,
    id: string,
    data: { role: Role; displayName: string; invitedByMembershipId: string; joinedAt: Date },
  ): Promise<void> {
    await this.prisma.db.membership.update({
      where: { orgId_id: { orgId, id } },
      data: { ...data, status: "ACTIVE" },
    })
  }

  async joinTeam(orgId: string, membershipId: string, teamId: string): Promise<void> {
    await this.prisma.db.teamMembership.create({ data: { orgId, membershipId, teamId } })
  }
}

type Row = {
  id: string
  orgId: string
  userId: string | null
  role: Role
  status: MembershipStatus
  kind: MembershipKind
  displayName: string
  teams: { teamId: string; isLead: boolean }[]
}

function toRecord({ teams, ...membership }: Row): MembershipRecord {
  return {
    ...membership,
    teamIds: teams.map((t) => t.teamId),
    leadOfTeamIds: teams.filter((t) => t.isLead).map((t) => t.teamId),
  }
}

type MemberQueryRow = Omit<MemberRow, "teams" | "contact"> & {
  teams: { isLead: boolean; team: { id: string; name: string } }[]
  user?: { email: string; lastLoginAt: Date | null } | null
}

function toMemberRow({ teams, user, ...row }: MemberQueryRow, withContact: boolean): MemberRow {
  return {
    ...row,
    teams: teams.map((t) => ({ id: t.team.id, name: t.team.name, isLead: t.isLead })),
    contact: withContact ? { email: user?.email ?? null, lastLoginAt: user?.lastLoginAt ?? null } : null,
  }
}
