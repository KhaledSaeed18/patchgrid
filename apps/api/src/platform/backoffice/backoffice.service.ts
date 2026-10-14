import { Injectable } from "@nestjs/common"
import {
  decodeCursor,
  encodeCursor,
  type Plan,
  type PlatformOrg,
  type PlatformOrgDetail,
  type PlatformOrgListQuery,
  type PlatformOrgPage,
  purgeDateFor,
} from "@patchgrid/contracts"

import { ActorService, type PlatformActor } from "../../auth/actor"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { RevocationEpochService } from "../../auth/revocation/revocation-epoch.service"
import { AuditService } from "../../audit/audit.service"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { PrismaService } from "../../prisma/prisma.service"
import { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import { PlatformAuditRepository } from "../repositories/platform-audit.repository"
import { runAsTenant } from "../run-as-tenant"
import { BackofficeRepository, type OrgRow } from "./repositories/backoffice.repository"

/**
 * The operators' back-office (RBAC.md §8): workspaces as metadata and counts,
 * and the few things an operator may change — suspend, unsuspend, set a plan.
 * Every change is written to the tenant's own log (as a `PLATFORM` actor) and
 * to the platform's. Nothing here reads tenant content: the counts are read
 * inside the tenant through `runAsTenant`, crossing logged, RLS on.
 */
@Injectable()
export class BackofficeService {
  constructor(
    private readonly orgs: BackofficeRepository,
    private readonly lookup: OrganizationLookupService,
    private readonly epochs: RevocationEpochService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditRepository,
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(query: PlatformOrgListQuery): Promise<PlatformOrgPage> {
    this.actors.requirePlatform()
    let after: { createdAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const createdAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      after = { createdAt, id: parts.id }
    }
    const rows = await this.orgs.list({
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.status === undefined ? {} : { status: query.status }),
      after,
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const members = await this.orgs.activeMembers(page.map((r) => r.id))
    const last = page.at(-1)
    return {
      items: page.map((row) => toOrg(row, members.get(row.id) ?? 0)),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id }) : null,
    }
  }

  async get(id: string): Promise<PlatformOrgDetail> {
    const actor = this.actors.requirePlatform()
    const row = await this.orgs.find(id)
    if (row === null) throw new NotFoundProblem()
    const counts = await runAsTenant(row.id, crossing(actor, "back-office counts"), () => this.prisma.transaction(() => this.orgs.countsIn(row.id)))
    const members = await this.orgs.activeMembers([row.id])
    return { ...toOrg(row, members.get(row.id) ?? 0), domain: row.domain, counts }
  }

  /** Out of service: its members are out on their next request, and its live streams with them. */
  async suspend(id: string, reason: string): Promise<PlatformOrgDetail> {
    const actor = this.actors.requirePlatform()
    const row = await this.orgs.find(id)
    if (row === null) throw new NotFoundProblem()
    if (!(await this.orgs.moveStatus(id, "ACTIVE", "SUSPENDED"))) throw new ConflictProblem(`The workspace is ${row.status.toLowerCase().replace("_", " ")}, not active`)
    await this.lookup.invalidate({ id: row.id, slug: row.slug })
    await runAsTenant(row.id, crossing(actor, "suspend"), async () => {
      await this.prisma.transaction(() => this.audit.record(row.id, [{ action: "ORG_SUSPENDED", entityType: "Organization", entityId: row.id, diff: { reason } }]))
      // Every member's sessions and streams end now, not when their token next expires (TENANCY.md §6).
      for (const membershipId of await this.prisma.transaction(() => this.orgs.membershipIdsIn(row.id))) await this.epochs.bump(membershipId)
    })
    await this.platformAudit.record({ platformAdminId: actor.platformAdminId, action: "PLATFORM_ORG_SUSPENDED", targetOrgId: row.id, diff: { reason } })
    return this.get(id)
  }

  async unsuspend(id: string): Promise<PlatformOrgDetail> {
    const actor = this.actors.requirePlatform()
    const row = await this.orgs.find(id)
    if (row === null) throw new NotFoundProblem()
    if (!(await this.orgs.moveStatus(id, "SUSPENDED", "ACTIVE"))) throw new ConflictProblem("The workspace is not suspended")
    await this.lookup.invalidate({ id: row.id, slug: row.slug })
    await runAsTenant(row.id, crossing(actor, "unsuspend"), () =>
      this.prisma.transaction(() => this.audit.record(row.id, [{ action: "ORG_UNSUSPENDED", entityType: "Organization", entityId: row.id }])),
    )
    await this.platformAudit.record({ platformAdminId: actor.platformAdminId, action: "PLATFORM_ORG_UNSUSPENDED", targetOrgId: row.id })
    return this.get(id)
  }

  /**
   * Undoes an owner's deletion request before the purge runs (RBAC.md §8,
   * ADR-0043): the workspace comes back as it was, and its admins read who
   * restored it in their own log.
   */
  async restore(id: string): Promise<PlatformOrgDetail> {
    const actor = this.actors.requirePlatform()
    const row = await this.orgs.find(id)
    if (row === null) throw new NotFoundProblem()
    // From the purge date on, the purge owns it; never restore a workspace it may be emptying (ADR-0043).
    if (row.deletionRequestedAt !== null && this.clock.now().getTime() >= purgeDateFor(row.deletionRequestedAt).getTime()) {
      throw new ConflictProblem("This workspace's deletion window has closed")
    }
    // Its last owner may have erased their account meanwhile (ADR-0044): an ownerless workspace is not restored.
    const owned = await runAsTenant(row.id, crossing(actor, "restore: check ownership"), () => this.prisma.transaction(() => this.orgs.hasActiveOwner(row.id)))
    if (!owned) throw new ConflictProblem("The workspace has no owner left to run it")
    if (!(await this.orgs.restoreDeletion(id))) throw new ConflictProblem("The workspace is not pending deletion")
    await this.lookup.invalidate({ id: row.id, slug: row.slug })
    await runAsTenant(row.id, crossing(actor, "restore"), () =>
      this.prisma.transaction(() => this.audit.record(row.id, [{ action: "ORG_DELETION_CANCELLED", entityType: "Organization", entityId: row.id }])),
    )
    await this.platformAudit.record({ platformAdminId: actor.platformAdminId, action: "PLATFORM_ORG_DELETION_RESTORED", targetOrgId: row.id })
    return this.get(id)
  }

  /** Plans are set by an operator (there is no self-serve billing). Limits follow at once; nothing is deleted. */
  async setPlan(id: string, plan: Plan): Promise<PlatformOrgDetail> {
    const actor = this.actors.requirePlatform()
    const row = await this.orgs.find(id)
    if (row === null) throw new NotFoundProblem()
    if (row.plan !== plan) {
      await this.orgs.setPlan(id, plan)
      await this.lookup.invalidate({ id: row.id, slug: row.slug })
      const diff = { plan: { from: row.plan, to: plan } }
      await runAsTenant(row.id, crossing(actor, "set plan"), () =>
        this.prisma.transaction(() => this.audit.record(row.id, [{ action: "ORG_PLAN_CHANGED", entityType: "Organization", entityId: row.id, diff }])),
      )
      await this.platformAudit.record({ platformAdminId: actor.platformAdminId, action: "PLATFORM_ORG_PLAN_SET", targetOrgId: row.id, diff })
    }
    return this.get(id)
  }
}

function crossing(actor: PlatformActor, reason: string) {
  return { actor: `platform-admin:${actor.platformAdminId}`, reason: `back-office: ${reason}` }
}

function toOrg(row: OrgRow, activeMembers: number): PlatformOrg {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    plan: row.plan,
    activeMembers,
    createdAt: row.createdAt.toISOString(),
    purgeAt: row.status === "PENDING_DELETION" && row.deletionRequestedAt !== null ? purgeDateFor(row.deletionRequestedAt).toISOString() : null,
  }
}
