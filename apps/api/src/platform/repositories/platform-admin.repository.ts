import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type PlatformAdminRecord = { id: string; userId: string; email: string; name: string; grantedAt: Date }

/** `PlatformAdmin` is platform class (ADR-0040). Granted and revoked by CLI only; read here. */
@Injectable()
export class PlatformAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The account's admin row, if it holds one that is not revoked. */
  async activeForUser(userId: string): Promise<PlatformAdminRecord | null> {
    const row = await this.prisma.db.platformAdmin.findFirst({
      where: { userId, revokedAt: null },
      select: { id: true, userId: true, grantedAt: true, user: { select: { email: true, name: true } } },
    })
    return row === null ? null : { id: row.id, userId: row.userId, email: row.user.email, name: row.user.name, grantedAt: row.grantedAt }
  }

  async active(id: string): Promise<PlatformAdminRecord | null> {
    const row = await this.prisma.db.platformAdmin.findFirst({
      where: { id, revokedAt: null },
      select: { id: true, userId: true, grantedAt: true, user: { select: { email: true, name: true } } },
    })
    return row === null ? null : { id: row.id, userId: row.userId, email: row.user.email, name: row.user.name, grantedAt: row.grantedAt }
  }
}
