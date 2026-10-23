import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { AttachmentRepository } from "../../attachments/repositories/attachment.repository"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { PrismaService } from "../../prisma/prisma.service"
import { QuotaService } from "../../quota/quota.service"
import { stagingKey } from "../../attachments/attachments.service"
import { StorageService } from "../../storage/storage.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { runJob } from "../dispatcher/run-job"
import { readTenantSweep } from "../sweeps"

/** An upload not completed within this long is abandoned (ADR-0005). */
export const ABANDONED_AFTER_MS = 60 * 60_000
const BATCH = 100
const MAX_BATCHES = 20

/**
 * The hourly `attachment-sweep` (ARCHITECTURE.md §Background jobs), for the
 * tenant the job names: uploads still `PENDING` an hour after their presign
 * are abandoned. Each batch's rows go and their storage quota comes back in
 * one transaction, under row locks a racing `complete` waits on; the objects
 * go after it commits, and an object that was never uploaded is simply not
 * there to delete.
 */
@Injectable()
export class AttachmentSweepService {
  private readonly logger = new Logger(AttachmentSweepService.name)

  constructor(
    private readonly attachments: AttachmentRepository,
    private readonly quota: QuotaService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** Runs inside the tenant context; returns how many abandoned uploads it removed. */
  async sweep(): Promise<number> {
    const orgId = this.tenant.requireOrgId()
    const cutoff = new Date(this.clock.now().getTime() - ABANDONED_AFTER_MS)
    let removed = 0
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const gone = await this.prisma.transaction(async () => {
        const rows = await this.attachments.removeAbandoned(orgId, cutoff, BATCH)
        const bytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0)
        if (bytes > 0) await this.quota.release(orgId, "STORAGE_BYTES", bytes)
        return rows
      })
      for (const row of gone) {
        // A pending upload's bytes are in staging (ADR-0038) — or, when a `complete` copied them just
        // before this batch took the row, at the final key too. Each key is the upload's own.
        for (const key of [stagingKey(row.storageKey), row.storageKey]) {
          await this.storage
            .remove(key)
            .catch((error: unknown) => this.logger.warn({ msg: "abandoned upload's object not removed", orgId, key, error: String(error) }))
        }
      }
      removed += gone.length
      if (gone.length < BATCH) break
    }
    if (removed > 0) this.logger.log({ msg: "abandoned uploads removed", orgId, removed })
    return removed
  }
}

@Processor("attachment-sweep", { autorun: false })
export class AttachmentSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: AttachmentSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:attachment-sweep", "remove abandoned uploads", () => this.service.sweep())
  }
}
