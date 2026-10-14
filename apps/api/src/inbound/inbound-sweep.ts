import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { StorageService } from "../storage/storage.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { InboundEmailRepository } from "./repositories/inbound-email.repository"

const DAY_MS = 24 * 60 * 60_000
/** A raw message is kept this long: long enough to look into a complaint, no longer. */
export const RAW_RETENTION_DAYS = 30
/** The log row of mail nothing was made of — refused, unknown, automatic — is kept this long. */
export const UNACTED_RETENTION_DAYS = 90
/** A claim older than this belongs to a worker that died. */
const CLAIM_ABANDONED_MS = 10 * 60_000
/** A message never claimed within this long was never going to be. */
const NEVER_CLAIMED_MS = 60 * 60_000
const BATCH = 200
const MAX_BATCHES = 10

/**
 * The hourly `inbound-sweep`, for the tenant the job names (ADR-0018): fails
 * messages no worker will finish, deletes raw messages past their retention,
 * and drops the log rows of mail nothing was made of. A row that became a
 * ticket or a reply is kept with the ticket; only its raw bytes go.
 */
@Injectable()
export class InboundSweepService {
  private readonly logger = new Logger(InboundSweepService.name)

  constructor(
    private readonly inbound: InboundEmailRepository,
    private readonly storage: StorageService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sweep(): Promise<{ failed: number; rawDeleted: number; rowsRemoved: number }> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const failed = await this.inbound.failStuck(orgId, new Date(now.getTime() - CLAIM_ABANDONED_MS), new Date(now.getTime() - NEVER_CLAIMED_MS), now)

    let rawDeleted = 0
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.inbound.rawPastRetention(orgId, new Date(now.getTime() - RAW_RETENTION_DAYS * DAY_MS), BATCH)
      const gone: string[] = []
      for (const row of rows) {
        try {
          await this.storage.remove(row.rawStorageKey)
          gone.push(row.id)
        } catch (error) {
          this.logger.warn({ msg: "inbound raw message not removed", orgId, key: row.rawStorageKey, error: String(error) })
        }
      }
      await this.inbound.markRawDeleted(orgId, gone, now)
      rawDeleted += gone.length
      if (rows.length < BATCH) break
    }
    const rowsRemoved = await this.inbound.removeUnacted(orgId, new Date(now.getTime() - UNACTED_RETENTION_DAYS * DAY_MS))
    if (failed + rawDeleted + rowsRemoved > 0) this.logger.log({ msg: "inbound swept", orgId, failed, rawDeleted, rowsRemoved })
    return { failed, rawDeleted, rowsRemoved }
  }
}

@Processor("inbound-sweep", { autorun: false })
export class InboundSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: InboundSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<{ failed: number; rawDeleted: number; rowsRemoved: number }> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:inbound-sweep", "settle stuck mail and keep retention", () => this.service.sweep())
  }
}
