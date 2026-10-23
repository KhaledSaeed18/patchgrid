import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { type UsageMetric, usagePeriod } from "@patchgrid/contracts"
import type { Job } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { UsageSourceRepository } from "./repositories/usage-source.repository"

/** One metric's recount: what the counter said, and what the rows say. */
export type Recount = { metric: UsageMetric; counted: bigint; stored: bigint; repaired: boolean }

/**
 * The nightly `usage-reconcile` sweep (TENANCY.md §8), for the tenant the job
 * names. The point-in-time metrics are recounted from their rows and the
 * counter set to the count, each under the counter's row lock, so a create
 * racing the recount waits and is counted once. The month's ticket count is
 * cumulative — a ticket is never uncreated — so a difference there is
 * reported, not rewritten. Every counter moves with its row in one
 * transaction, so any drift is a bug, and is logged as one.
 */
@Injectable()
export class UsageReconcileService {
  private readonly logger = new Logger(UsageReconcileService.name)

  constructor(
    private readonly sources: UsageSourceRepository,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async reconcile(): Promise<Recount[]> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const recounts: Recount[] = []
    const recompute: [UsageMetric, () => Promise<bigint>][] = [
      ["AGENT_SEATS", () => this.sources.seats(orgId)],
      ["KB_ARTICLES", () => this.sources.articles(orgId)],
      ["STORAGE_BYTES", () => this.sources.storageBytes(orgId)],
      ["API_TOKENS", () => this.sources.apiTokens(orgId)],
    ]
    for (const [metric, count] of recompute) {
      recounts.push(
        await this.prisma.transaction(async () => {
          const period = usagePeriod(metric, now)
          const stored = await this.sources.lockCounter(orgId, period, metric)
          const counted = await count()
          if (counted !== stored) await this.sources.setCounter(orgId, period, metric, counted)
          return { metric, counted, stored, repaired: counted !== stored }
        }),
      )
    }
    recounts.push(
      await this.prisma.transaction(async () => {
        const period = usagePeriod("TICKETS_CREATED", now)
        const stored = await this.sources.lockCounter(orgId, period, "TICKETS_CREATED")
        const from = new Date(`${period}-01T00:00:00.000Z`)
        const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
        const counted = await this.sources.ticketsCreated(orgId, from, to)
        return { metric: "TICKETS_CREATED" as const, counted, stored, repaired: false }
      }),
    )
    const drift = recounts.filter((r) => r.counted !== r.stored)
    if (drift.length > 0) {
      this.logger.warn({
        msg: "usage counters drifted",
        orgId,
        drift: drift.map((r) => ({ metric: r.metric, stored: String(r.stored), counted: String(r.counted), repaired: r.repaired })),
      })
    }
    return recounts
  }
}

@Processor("usage-reconcile", { autorun: false })
export class UsageReconcileProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: UsageReconcileService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    const recounts = await runJob({ orgId }, "job:usage-reconcile", "recount the plan's counters from their rows", () =>
      this.service.reconcile(),
    )
    return recounts.filter((r) => r.counted !== r.stored).length
  }
}
