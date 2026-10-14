import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { OrgExportRepository } from "../../exports/repositories/org-export.repository"
import { PrismaService } from "../../prisma/prisma.service"
import { StorageService } from "../../storage/storage.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { runJob } from "../dispatcher/run-job"
import { readTenantSweep } from "../sweeps"
import { RetentionRepository } from "./repositories/retention.repository"

/** Notifications are kept this long (ADR-0028). */
export const NOTIFICATION_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60_000

/**
 * Daily, per tenant (ADR-0028, ADR-0044): notifications past 90 days go, and
 * exports past their link lose their archive — object first, then the row
 * says `EXPIRED`, so a failure between leaves a row that is retried tomorrow,
 * never an object nothing points at.
 */
@Injectable()
export class RetentionSweepService {
  constructor(
    private readonly retention: RetentionRepository,
    private readonly exports: OrgExportRepository,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sweep(): Promise<{ notifications: number; exports: number }> {
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
    return { notifications, exports: lapsed.length }
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

  async process(job: Job): Promise<{ notifications: number; exports: number }> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:retention-sweep", "delete what the retention table says is past keeping", () => this.service.sweep())
  }
}
