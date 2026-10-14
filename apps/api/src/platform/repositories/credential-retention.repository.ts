import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * Platform-class credentials past keeping (ADR-0028, ADR-0044): refresh,
 * reset and verification tokens 30 days past their expiry. Hashes only —
 * nothing here was ever a usable secret at rest — but a table of dead rows
 * is a table nobody needs. A rotation chain expires oldest first, so one
 * statement takes a link together with what pointed at it.
 */
@Injectable()
export class CredentialRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async deleteExpiredBefore(before: Date): Promise<{ refresh: number; reset: number; verification: number }> {
    const refresh = await this.prisma.db.refreshToken.deleteMany({ where: { expiresAt: { lt: before } } })
    const reset = await this.prisma.db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: before } } })
    const verification = await this.prisma.db.emailVerification.deleteMany({ where: { expiresAt: { lt: before } } })
    return { refresh: refresh.count, reset: reset.count, verification: verification.count }
  }
}
