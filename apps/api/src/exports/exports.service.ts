import { InjectQueue } from "@nestjs/bullmq"
import { Injectable } from "@nestjs/common"
import { EXPORT_COOLDOWN_HOURS, type ExportDownload, type OrgExport } from "@patchgrid/contracts"
import type { Queue } from "bullmq"

import { ActorService } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, RateLimitedProblem } from "../common/problems/problem.exception"
import { jobId } from "../jobs/job-id"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { toOrgExport } from "./domain"
import { OrgExportRepository } from "./repositories/org-export.repository"

export const EXPORT_QUEUE = "org-export"
const HOUR_MS = 60 * 60_000
const DOWNLOAD_TTL_SECONDS = 15 * 60

/** What an export job carries: the tenant, and which export. */
export type ExportJob = { orgId: string; exportId: string }

/**
 * The owner's side of exports (ADR-0028, ADR-0044): ask for one — at most
 * one a day, a failed one not counted — see them listed, and download a
 * ready one while it lasts. The building happens on the export queue.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly exports: OrgExportRepository,
    private readonly memberships: MembershipRepository,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectQueue(EXPORT_QUEUE) private readonly queue: Queue,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async request(): Promise<OrgExport> {
    const actor = this.actors.requireMember()
    this.permissions.assert(actor, "org:export")
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const id = await this.prisma.transaction(async () => {
      // Under the org lock, two owners asking at once get one export between them.
      await this.memberships.lockOrganization(orgId)
      const last = await this.exports.latestCounted(orgId)
      const next = last === null ? null : last.getTime() + EXPORT_COOLDOWN_HOURS * HOUR_MS
      if (next !== null && next > now.getTime()) throw new RateLimitedProblem(Math.ceil((next - now.getTime()) / 1000))
      const created = await this.exports.create(orgId, actor.membershipId, now)
      await this.audit.record(orgId, [{ action: "ORG_EXPORTED", entityType: "Organization", entityId: orgId, diff: { exportId: created } }])
      return created
    })
    const job: ExportJob = { orgId, exportId: id }
    await this.queue.add(EXPORT_QUEUE, job, { jobId: jobId(EXPORT_QUEUE, orgId, id, "build"), attempts: 1 })
    return this.one(orgId, id)
  }

  async list(): Promise<OrgExport[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:export")
    return (await this.exports.list(this.tenant.requireOrgId())).map(toOrgExport)
  }

  /** A fresh, short link to a ready export's zip, while it lasts. */
  async download(id: string): Promise<ExportDownload> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:export")
    const orgId = this.tenant.requireOrgId()
    const row = await this.exports.find(orgId, id)
    if (row === null) throw new NotFoundProblem()
    const now = this.clock.now()
    if (row.status !== "READY" || row.storageKey === null || (row.expiresAt?.getTime() ?? 0) <= now.getTime()) {
      throw new ConflictProblem("This export is not ready, or has lapsed")
    }
    const filename = `${this.tenant.organization()?.slug ?? "workspace"}-export-${row.requestedAt.toISOString().slice(0, 10)}.zip`
    const url = await this.storage.presignGet(
      row.storageKey,
      { filename, contentType: "application/zip", inline: false },
      DOWNLOAD_TTL_SECONDS,
    )
    return { url, expiresAt: new Date(now.getTime() + DOWNLOAD_TTL_SECONDS * 1000).toISOString() }
  }

  private async one(orgId: string, id: string): Promise<OrgExport> {
    const row = await this.exports.find(orgId, id)
    if (row === null) throw new NotFoundProblem()
    return toOrgExport(row)
  }
}
