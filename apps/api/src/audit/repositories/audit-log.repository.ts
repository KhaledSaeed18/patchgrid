import { Injectable } from "@nestjs/common"
import type { AuditAction, AuditActorKind } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type AuditRow = {
  entityType: string
  entityId: string
  action: AuditAction
  diff: Record<string, unknown>
  actorKind: AuditActorKind
  actorMembershipId: string | null
  createdAt: Date
}

/**
 * The tenant's audit log (ADR-0034). Appends only — an audit row is never
 * updated — through `prisma.db`, so a write made inside `transaction()` commits
 * or rolls back with the change it records.
 */
@Injectable()
export class AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(orgId: string, rows: readonly AuditRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.prisma.db.auditLog.createMany({
      data: rows.map((row) => ({ orgId, ...row, diff: row.diff as object })),
    })
  }

  /**
   * Makes sure the month partition holding `at` exists, through the one
   * function the app role may execute to create anything (ADR-0034). No tenant
   * is involved: partitions are shared, and the function writes no rows.
   */
  async ensurePartition(at: Date): Promise<string> {
    const [row] = await this.prisma.db.$queryRaw<{ name: string }[]>`
      SELECT ensure_audit_log_partition(${at}::timestamptz) AS name`
    if (row === undefined) throw new Error("ensure_audit_log_partition returned nothing")
    return row.name
  }
}
