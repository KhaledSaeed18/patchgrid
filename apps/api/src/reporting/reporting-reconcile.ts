import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { PrismaService } from "../prisma/prisma.service"
import { recordReportingDrift } from "../telemetry/metrics"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type Fact, factOf, sameFact } from "./domain/fact"
import { ReportingRepository } from "./repositories/reporting.repository"

/** Tickets read and compared per transaction. */
const BATCH = 500

export type Reconciled = { checked: number; drifted: number }

/**
 * Builds and checks the facts from the source (ADR-0051), nightly per
 * tenant: every ticket, in id order and batches, through the same `factOf`
 * the consumer uses. A fact that is missing or says something else is
 * written and counted as drift. On first run that is the history the log never
 * saw (the seed, anything past its retention); after that, drift means the log
 * missed a write, which is a bug.
 */
@Injectable()
export class ReportingReconcileService {
  private readonly logger = new Logger(ReportingReconcileService.name)

  constructor(
    private readonly reporting: ReportingRepository,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async reconcile(): Promise<Reconciled> {
    const orgId = this.tenant.requireOrgId()
    let after: string | null = null
    let checked = 0
    let drifted = 0
    for (;;) {
      const cursor: string | null = after
      const batch = await this.prisma.transaction(async () => {
        const tickets = await this.reporting.page(orgId, cursor, BATCH)
        const stored = new Map((await this.reporting.facts(orgId, tickets.map((t) => t.id))).map((f) => [f.ticketId, f]))
        const changed: Fact[] = tickets.map(factOf).filter((fact) => {
          const current = stored.get(fact.ticketId)
          return current === undefined || !sameFact(current, fact)
        })
        await this.reporting.upsert(orgId, changed)
        return { count: tickets.length, changed: changed.length, last: tickets.at(-1)?.id ?? null }
      })
      checked += batch.count
      drifted += batch.changed
      if (batch.count < BATCH || batch.last === null) break
      after = batch.last
    }
    if (drifted > 0) {
      recordReportingDrift(orgId, drifted)
      this.logger.warn({ msg: "reporting facts drifted from their tickets", orgId, drifted, checked })
    }
    return { checked, drifted }
  }
}

@Processor("reporting-reconcile", { autorun: false })
export class ReportingReconcileProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: ReportingReconcileService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<Reconciled> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:reporting-reconcile", "build and check the reporting facts", () => this.service.reconcile())
  }
}
