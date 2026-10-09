import { Injectable } from "@nestjs/common"
import {
  type AuditAction,
  type AuditPage,
  type AuditQuery,
  auditActionSchema,
  decodeCursor,
  encodeCursor,
} from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { ValidationProblem } from "../common/problems/problem.exception"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { AuditLogRepository, type AuditListRow } from "./repositories/audit-log.repository"

/** The tenant's own audit log, for its admins (RBAC.md §12): `GET /org/audit`. */
@Injectable()
export class OrgAuditService {
  constructor(
    private readonly repository: AuditLogRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * One ticket's trail, oldest first, for whoever may read it (`ticket:read_audit`,
   * asserted by the caller on the loaded ticket). Capped: a ticket's history is
   * hundreds of rows at most.
   */
  async forEntity(orgId: string, type: string, id: string): Promise<AuditPage["items"]> {
    const rows = await this.repository.list(orgId, { entity: { type, id }, limit: 500, before: null })
    return rows.map(toEntry).reverse()
  }

  async list(query: AuditQuery): Promise<AuditPage> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_audit")

    let before: { createdAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const createdAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      before = { createdAt, id: parts.id }
    }

    const rows = await this.repository.list(this.tenant.requireOrgId(), {
      actorMembershipId: query.actorMembershipId,
      action: query.action,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      limit: query.limit + 1,
      before,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toEntry),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  }
}

export function toEntry(row: AuditListRow): AuditPage["items"][number] {
  return {
    id: row.id,
    // Written only through AuditService from the same catalogue; parsed rather than cast regardless.
    action: auditActionSchema.parse(row.action) satisfies AuditAction,
    entityType: row.entityType,
    entityId: row.entityId,
    diff: isRecord(row.diff) ? row.diff : {},
    actor: { kind: row.actorKind, membershipId: row.actorMembershipId, displayName: row.actorDisplayName },
    createdAt: row.createdAt.toISOString(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
