import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { purgeDateFor } from "@patchgrid/contracts"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { PlatformAuditRepository } from "../../platform/repositories/platform-audit.repository"
import { PrismaService } from "../../prisma/prisma.service"
import { StorageService } from "../../storage/storage.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { runJob } from "../dispatcher/run-job"
import { readTenantSweep } from "../sweeps"
import { OrgPurgeRepository } from "./repositories/org-purge.repository"

/**
 * How long past its purge date a workspace waits before the purge starts.
 * A cancel or restore is refused from the purge date on; the hour between is
 * what keeps two clocks from disagreeing about which one won (ADR-0043).
 */
export const PURGE_GRACE_HOURS = 1

export type PurgeReport = { objects: number; rows: Record<string, number> }

/**
 * The purge (TENANCY.md §3, ADR-0043), for the tenant the job names, inside
 * `runAsTenant` so RLS is enforcing for the most destructive thing the
 * product does. It checks the org under a row lock first: no longer pending,
 * or not yet past its grace, and it stops. Then the objects, then the rows,
 * one table per transaction, children first; a job that dies halfway is
 * retried — by BullMQ, then by tomorrow's dispatch, which still finds the org
 * pending — and finishes the rest. The tombstone is last, so "pending" means
 * "not finished" until the end.
 */
@Injectable()
export class OrgPurgeService {
  private readonly logger = new Logger(OrgPurgeService.name)

  constructor(
    private readonly purge: OrgPurgeRepository,
    private readonly storage: StorageService,
    private readonly platformAudit: PlatformAuditRepository,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async run(): Promise<PurgeReport | null> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const due = await this.prisma.transaction(async () => {
      const org = await this.purge.lock(orgId)
      if (org?.status !== "PENDING_DELETION" || org.deletionRequestedAt === null) return false
      return purgeDateFor(org.deletionRequestedAt).getTime() + PURGE_GRACE_HOURS * 60 * 60_000 <= now.getTime()
    })
    if (!due) return null

    // Objects first: a row without its object is harmless; an object without its row is a leak.
    const objects = (await this.storage.removePrefix(`org/${orgId}/`)) + (await this.storage.removePrefix(`staging/org/${orgId}/`))
    const rows: Record<string, number> = {}
    for (const step of this.purge.steps) rows[step.table] = await this.prisma.transaction(() => step.run(orgId))

    const done = await this.prisma.transaction(async () => {
      if ((await this.purge.lock(orgId))?.status !== "PENDING_DELETION") return false
      return this.purge.tombstone(orgId, now)
    })
    if (!done) return null
    await this.platformAudit.record({ platformAdminId: null, action: "PLATFORM_ORG_PURGED", targetOrgId: orgId, diff: { objects, rows } })
    this.logger.log({ msg: "workspace purged", orgId, objects, rows: Object.values(rows).reduce((a, b) => a + b, 0) })
    return { objects, rows }
  }
}

@Processor("org-purge", { autorun: false })
export class OrgPurgeProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: OrgPurgeService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<PurgeReport | null> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:org-purge", "erase a workspace past its deletion window", () => this.service.run())
  }
}
