import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type TeamRecord = { id: string; orgId: string; name: string; isActive: boolean }

const RECORD = { id: true, orgId: true, name: true, isActive: true } as const

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class TeamRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(orgId: string, id: string): Promise<TeamRecord | null> {
    return this.prisma.db.team.findUnique({ where: { orgId_id: { orgId, id } }, select: RECORD })
  }
}
