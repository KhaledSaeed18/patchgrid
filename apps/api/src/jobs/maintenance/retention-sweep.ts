import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import { AUDIT_RETENTION_YEARS } from "@patchgrid/contracts"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { OrgExportRepository } from "../../exports/repositories/org-export.repository"
import { EventConsumers } from "../../events/consumer"
import { PrismaService } from "../../prisma/prisma.service"
import { StorageService } from "../../storage/storage.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { runJob } from "../dispatcher/run-job"
import { readTenantSweep } from "../sweeps"
import { RetentionRepository } from "./repositories/retention.repository"

/** Notifications are kept this long (ADR-0028). */
export const NOTIFICATION_RETENTION_DAYS = 90
/** Outbox events every consumer has read, and finished webhook deliveries, are kept this long (ADR-0049, ADR-0050). */
export const EVENT_RETENTION_DAYS = 30
/** Events deleted per statement: a tenant with a long backlog of history is trimmed over several, not in one lock. */
const EVENT_BATCH = 5_000
/** Audit rows deleted per statement, for a plan whose window is shorter than the archival's. */
const AUDIT_BATCH = 5_000
const DAY_MS = 24 * 60 * 60_000
/** The archival's window (ADR-0034): a plan that keeps this long is trimmed by detaching whole months, not here. */
const ARCHIVED_AFTER_YEARS = Math.max(...Object.values(AUDIT_RETENTION_YEARS))

export type RetentionSwept = { notifications: number; exports: number; deliveries: number; events: number; audit: number }

/**
 * Daily, per tenant (ADR-0028, ADR-0044): notifications past 90 days go, and
 * exports past their link lose their archive — object first, then the row
 * says `EXPIRED`, so a failure between leaves a row that is retried tomorrow,
 * never an object nothing points at. Finished webhook deliveries past 30 days
 * go, then the outbox events every consumer has read and nothing points at.
 * On a plan that keeps its audit log for less than the archival's seven
 * years, the rows past its window go too, a batch at a time.
 */
@Injectable()
export class RetentionSweepService {
  constructor(
    private readonly retention: RetentionRepository,
    private readonly exports: OrgExportRepository,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly consumers: EventConsumers,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sweep(): Promise<RetentionSwept> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const notifications = await this.prisma.transaction(() =>
      this.retention.deleteNotificationsBefore(orgId, new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS)),
    )
    const lapsed = await this.prisma.transaction(() => this.exports.lapsed(orgId, now))
    for (const row of lapsed) {
      if (row.storageKey !== null) await this.storage.remove(row.storageKey)
      await this.prisma.transaction(() => this.exports.expire(orgId, row.id))
    }
    const window = new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_MS)
    // Deliveries first: an event a delivery still points at is never deleted.
    const deliveries = await this.prisma.transaction(() => this.retention.deleteFinishedDeliveriesBefore(orgId, window))
    let events = 0
    for (;;) {
      const deleted = await this.prisma.transaction(() =>
        this.retention.deleteConsumedEventsBefore(orgId, window, this.consumers.names(), EVENT_BATCH),
      )
      events += deleted
      if (deleted < EVENT_BATCH) break
    }
    const audit = await this.trimAudit(orgId, now)
    return { notifications, exports: lapsed.length, deliveries, events, audit }
  }

  private async trimAudit(orgId: string, now: Date): Promise<number> {
    const plan = await this.prisma.transaction(() => this.retention.plan(orgId))
    if (plan === null) return 0
    const years = AUDIT_RETENTION_YEARS[plan]
    if (years >= ARCHIVED_AFTER_YEARS) return 0
    const before = new Date(now)
    before.setUTCFullYear(before.getUTCFullYear() - years)
    let audit = 0
    for (;;) {
      const deleted = await this.prisma.transaction(() => this.retention.deleteAuditBefore(orgId, before, AUDIT_BATCH))
      audit += deleted
      if (deleted < AUDIT_BATCH) return audit
    }
  }
}

@Processor("retention-sweep", { autorun: false })
export class RetentionSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: RetentionSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<RetentionSwept> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:retention-sweep", "delete what the retention table says is past keeping", () => this.service.sweep())
  }
}
