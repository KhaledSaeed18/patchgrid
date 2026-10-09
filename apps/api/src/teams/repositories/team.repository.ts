import { Injectable } from "@nestjs/common"
import type { Role } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type TeamRecord = { id: string; orgId: string; name: string; isActive: boolean }

export type TeamRow = {
  id: string
  name: string
  description: string | null
  isActive: boolean
  memberCount: number
  lead: { membershipId: string; displayName: string } | null
}

export type TeamMemberRow = { membershipId: string; displayName: string; role: Role; isLead: boolean; joinedAt: Date }

/** A write that hit the per-organization unique name (ARCHITECTURE.md §Data model). */
export type NameTaken = "name-taken"

const RECORD = { id: true, orgId: true, name: true, isActive: true } as const

const ROW = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  _count: { select: { members: true } },
  members: { where: { isLead: true }, select: { membershipId: true, membership: { select: { displayName: true } } } },
} as const

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class TeamRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(orgId: string, id: string): Promise<TeamRecord | null> {
    return this.prisma.db.team.findUnique({ where: { orgId_id: { orgId, id } }, select: RECORD })
  }

  async list(orgId: string): Promise<TeamRow[]> {
    const rows = await this.prisma.db.team.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: ROW })
    return rows.map(toRow)
  }

  async findRow(orgId: string, id: string): Promise<TeamRow | null> {
    const row = await this.prisma.db.team.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
    return row === null ? null : toRow(row)
  }

  async members(orgId: string, teamId: string): Promise<TeamMemberRow[]> {
    const rows = await this.prisma.db.teamMembership.findMany({
      where: { orgId, teamId },
      orderBy: { joinedAt: "asc" },
      select: { membershipId: true, isLead: true, joinedAt: true, membership: { select: { displayName: true, role: true } } },
    })
    return rows.map((r) => ({
      membershipId: r.membershipId,
      displayName: r.membership.displayName,
      role: r.membership.role,
      isLead: r.isLead,
      joinedAt: r.joinedAt,
    }))
  }

  /** Serialises changes to one team's membership and lead, so "at most one lead" is decided on committed data. */
  async lock(orgId: string, id: string): Promise<void> {
    await this.prisma.db.$queryRaw`SELECT id FROM "Team" WHERE "orgId" = ${orgId}::uuid AND id = ${id}::uuid FOR UPDATE`
  }

  async create(orgId: string, data: { name: string; description: string | null }): Promise<string | NameTaken> {
    try {
      const row = await this.prisma.db.team.create({ data: { orgId, ...data }, select: { id: true } })
      return row.id
    } catch (error) {
      if (isUniqueViolation(error)) return "name-taken"
      throw error
    }
  }

  async update(
    orgId: string,
    id: string,
    // `undefined` leaves a field alone, as a partial update from the wire carries it.
    data: { name?: string | undefined; description?: string | null | undefined; isActive?: boolean | undefined },
  ): Promise<void | NameTaken> {
    try {
      await this.prisma.db.team.update({
        where: { orgId_id: { orgId, id } },
        data: {
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.description === undefined ? {} : { description: data.description }),
          ...(data.isActive === undefined ? {} : { isActive: data.isActive }),
        },
      })
    } catch (error) {
      if (isUniqueViolation(error)) return "name-taken"
      throw error
    }
  }

  findMembership(orgId: string, teamId: string, membershipId: string): Promise<{ isLead: boolean } | null> {
    return this.prisma.db.teamMembership.findUnique({
      where: { orgId_teamId_membershipId: { orgId, teamId, membershipId } },
      select: { isLead: true },
    })
  }

  async addMember(orgId: string, teamId: string, membershipId: string): Promise<void> {
    await this.prisma.db.teamMembership.create({ data: { orgId, teamId, membershipId } })
  }

  async removeMember(orgId: string, teamId: string, membershipId: string): Promise<void> {
    await this.prisma.db.teamMembership.delete({
      where: { orgId_teamId_membershipId: { orgId, teamId, membershipId } },
    })
  }

  /** Clears the team's lead, if any, and says who it was. */
  async clearLead(orgId: string, teamId: string): Promise<string | null> {
    const current = await this.prisma.db.teamMembership.findFirst({
      where: { orgId, teamId, isLead: true },
      select: { membershipId: true },
    })
    if (current === null) return null
    await this.prisma.db.teamMembership.update({
      where: { orgId_teamId_membershipId: { orgId, teamId, membershipId: current.membershipId } },
      data: { isLead: false },
    })
    return current.membershipId
  }

  async makeLead(orgId: string, teamId: string, membershipId: string): Promise<void> {
    await this.prisma.db.teamMembership.update({
      where: { orgId_teamId_membershipId: { orgId, teamId, membershipId } },
      data: { isLead: true },
    })
  }
}

type RowQuery = {
  id: string
  name: string
  description: string | null
  isActive: boolean
  _count: { members: number }
  members: { membershipId: string; membership: { displayName: string } }[]
}

function toRow({ _count, members, ...team }: RowQuery): TeamRow {
  const [lead] = members
  return {
    ...team,
    memberCount: _count.members,
    lead: lead === undefined ? null : { membershipId: lead.membershipId, displayName: lead.membership.displayName },
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
