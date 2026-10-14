import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../../prisma/prisma.service"

/**
 * The retention table's per-tenant rows (ADR-0028, ADR-0044), inside
 * `runAsTenant` for the org the sweep names.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Notifications are delivery state, kept 90 days. */
  async deleteNotificationsBefore(orgId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.db.notification.deleteMany({ where: { orgId, createdAt: { lt: before } } })
    return count
  }
}
