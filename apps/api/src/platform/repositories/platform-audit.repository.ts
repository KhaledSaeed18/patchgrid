import { Injectable } from "@nestjs/common"
import type { PlatformAuditAction } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

/** The platform's own log (ADR-0040). Append-only; platform class. */
@Injectable()
export class PlatformAuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    platformAdminId: string | null
    action: PlatformAuditAction
    targetOrgId?: string
    targetUserId?: string
    diff?: Prisma.InputJsonObject
  }): Promise<void> {
    await this.prisma.db.platformAuditLog.create({ data: { ...entry, diff: entry.diff ?? {} } })
  }
}
