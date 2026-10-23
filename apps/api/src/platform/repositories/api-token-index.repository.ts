import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

/** One index row, as the reconcile compares it with `ApiToken` (ADR-0042). */
export type TokenIndexRow = { prefix: string; revokedAt: Date | null }

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

  /** One org's rows, for the reconcile. */
  rowsForOrg(orgId: string): Promise<TokenIndexRow[]> {
    return this.prisma.db.apiTokenIndex.findMany({ where: { orgId }, select: { prefix: true, revokedAt: true } })
  }

  /** The reconcile's repairs. Updates are one statement each: a token drifts one revocation at a time. */
  async writeForOrg(
    orgId: string,
    plan: { create: readonly TokenIndexRow[]; update: readonly TokenIndexRow[]; remove: readonly string[] },
  ): Promise<void> {
    if (plan.create.length > 0)
      await this.prisma.db.apiTokenIndex.createMany({ data: plan.create.map((row) => ({ orgId, ...row })), skipDuplicates: true })
    for (const row of plan.update) {
      await this.prisma.db.apiTokenIndex.updateMany({ where: { orgId, prefix: row.prefix }, data: { revokedAt: row.revokedAt } })
    }
    if (plan.remove.length > 0) await this.prisma.db.apiTokenIndex.deleteMany({ where: { orgId, prefix: { in: [...plan.remove] } } })
  }
}
