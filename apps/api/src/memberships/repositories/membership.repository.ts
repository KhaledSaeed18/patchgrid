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

/**
 * The first tenant-owned repository. Every method takes an explicit `orgId`
 * and filters on it — isolation layer 2 — even though the client extension
 * and RLS underneath would each catch a mistake on their own (TENANCY.md §7).
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
