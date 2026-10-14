import { Injectable } from "@nestjs/common"
import type { AuditEntry } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { OrgAuditService } from "../audit/org-audit.service"
import { PermissionService } from "../authz/permission.service"
import { NotFoundProblem } from "../common/problems/problem.exception"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { TicketAccess } from "./ticket-access"

/** A ticket's own audit trail, oldest first, for agents in scope and admins (RBAC.md §6). */
@Injectable()
export class TicketAuditService {
  constructor(
    private readonly access: TicketAccess,
    private readonly audit: OrgAuditService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
  ) {}

  async trail(ticketId: string): Promise<AuditEntry[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    const loaded = await this.access.load(orgId, ticketId, actor, org.agentVisibility)
    this.permissions.assertVisible(actor, "ticket:read_audit", loaded.subject)
    const entries = await this.audit.forEntity(orgId, "Ticket", ticketId)
    // Whoever reads the trail but not internal notes — a token without `comments:internal` (RBAC.md §10) —
    // gets what the entries say happened, never what an internal note or its file said.
    return this.permissions.can(actor, "comment:read_internal", loaded.subject) ? entries : entries.map(withoutInternalText)
  }
}

/** Fields that can carry an internal note's words; kept only on an entry that says it was public. */
const INTERNAL_TEXT = ["previousBody", "filename"] as const

/** An entry from before `internal` was recorded counts as internal: nothing was ever said to be public. */
export function withoutInternalText(entry: AuditEntry): AuditEntry {
  const diff = entry.diff as Record<string, unknown>
  if (diff.internal === false || !INTERNAL_TEXT.some((field) => field in diff)) return entry
  const kept = Object.fromEntries(Object.entries(diff).filter(([field]) => !(INTERNAL_TEXT as readonly string[]).includes(field)))
  return { ...entry, diff: { ...kept, redacted: true } }
}
