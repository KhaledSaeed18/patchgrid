import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * The projection that answers "which tenant does this token prefix belong
 * to?" before a tenant is known (ADR-0022). It holds a prefix and an org id —
 * no secret, no hash, no scopes. Verifying the secret happens later, inside
 * `runAsTenant`, against the real `ApiToken` row.
 */
@Injectable()
export class ApiTokenIndexRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByPrefix(prefix: string): Promise<{ orgId: string; revokedAt: Date | null } | null> {
    return this.prisma.db.apiTokenIndex.findUnique({
      where: { prefix },
      select: { orgId: true, revokedAt: true },
    })
  }

  /** Written in the same transaction as the `ApiToken` row it mirrors (ADR-0042). */
  async create(prefix: string, orgId: string): Promise<void> {
    await this.prisma.db.apiTokenIndex.create({ data: { prefix, orgId } })
  }

  /** Mirrors a revocation; the prefix stops resolving once the lookup cache drops it. */
  async revoke(prefix: string, orgId: string, at: Date): Promise<void> {
    await this.prisma.db.apiTokenIndex.updateMany({ where: { prefix, orgId, revokedAt: null }, data: { revokedAt: at } })
  }
}
