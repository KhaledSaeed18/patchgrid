import { Injectable } from "@nestjs/common"
import type { Priority, TicketType } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type SlaPolicyRecord = {
  id: string
  ticketType: TicketType
  priority: Priority
  responseTargetMinutes: number
  resolutionTargetMinutes: number
  responseWarningMinutes: number
  resolutionWarningMinutes: number
}

const RECORD = {
  id: true,
  ticketType: true,
  priority: true,
  responseTargetMinutes: true,
  resolutionTargetMinutes: true,
  responseWarningMinutes: true,
  resolutionWarningMinutes: true,
} as const

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class SlaPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(orgId: string): Promise<SlaPolicyRecord[]> {
    return this.prisma.db.sLAPolicy.findMany({
      where: { orgId },
      orderBy: [{ ticketType: "asc" }, { priority: "desc" }],
      select: RECORD,
    })
  }

  findById(orgId: string, id: string): Promise<SlaPolicyRecord | null> {
    return this.prisma.db.sLAPolicy.findUnique({ where: { orgId_id: { orgId, id } }, select: RECORD })
  }

  find(orgId: string, ticketType: TicketType, priority: Priority): Promise<SlaPolicyRecord | null> {
    return this.prisma.db.sLAPolicy.findUnique({
      where: { orgId_ticketType_priority: { orgId, ticketType, priority } },
      select: RECORD,
    })
  }

  async update(
    orgId: string,
    id: string,
    targets: Omit<SlaPolicyRecord, "id" | "ticketType" | "priority">,
  ): Promise<void> {
    await this.prisma.db.sLAPolicy.update({ where: { orgId_id: { orgId, id } }, data: targets })
  }
}
