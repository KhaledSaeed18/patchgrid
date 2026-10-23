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
    contactEmail: withContact,
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

  /** The memberships these people hold here — one query, for revoking a batch of sessions (ADR-0054). */
  async idsForUsers(orgId: string, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return []
    const rows = await this.prisma.db.membership.findMany({ where: { orgId, userId: { in: [...userIds] } }, select: { id: true } })
    return rows.map((row) => row.id)
  }

  /**
   * Active people below owner whose address is not at `domain`: who "SSO
   * required" would shut out, since a provider vouches only for its own
   * domain (M13 review).
   */
  async countOffDomain(orgId: string, domain: string): Promise<number> {
    return this.prisma.db.membership.count({
      where: { orgId, kind: "HUMAN", status: "ACTIVE", role: { not: "OWNER" }, user: { email: { not: { endsWith: `@${domain}` } } } },
    })
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

  /**
   * The external requester who writes from this address (ADR-0027 §4), made
   * on their first message: a `REQUESTER` with no account and the address as
   * its contact. A concurrent first message finds the other's row through the
   * partial unique index, and is told so by `null`.
   */
  async findOrCreateExternal(orgId: string, email: string, displayName: string, at: Date): Promise<MembershipRecord | null> {
    const existing = await this.prisma.db.membership.findFirst({ where: { orgId, kind: "EXTERNAL", contactEmail: email }, select: RECORD })
    if (existing !== null) return toRecord(existing)
    const created = await this.prisma.db.membership.createMany({
      data: [{ orgId, kind: "EXTERNAL", role: "REQUESTER", status: "ACTIVE", contactEmail: email, displayName, joinedAt: at }],
      skipDuplicates: true,
    })
    if (created.count === 0) return null
    const row = await this.prisma.db.membership.findFirst({ where: { orgId, kind: "EXTERNAL", contactEmail: email }, select: RECORD })
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
              OR: [{ createdAt: { gt: query.after.createdAt } }, { createdAt: query.after.createdAt, id: { gt: query.after.id } }],
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
    await this.prisma.tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`
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
      /** `null` when nobody invited them: provisioned by the workspace's identity provider (ADR-0054). */
      invitedByMembershipId: string | null
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
  contactEmail?: string | null
}

function toMemberRow({ teams, user, contactEmail, ...row }: MemberQueryRow, withContact: boolean): MemberRow {
  return {
    ...row,
    teams: teams.map((t) => ({ id: t.team.id, name: t.team.name, isLead: t.isLead })),
    // An external requester's address is their contact (ADR-0027 §4); they never sign in.
    contact: withContact ? { email: user?.email ?? contactEmail ?? null, lastLoginAt: user?.lastLoginAt ?? null } : null,
  }
}
