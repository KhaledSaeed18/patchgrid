import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { readTenantSweep } from "../../jobs/sweeps"
import { PrismaService } from "../../prisma/prisma.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { ProjectionRepository } from "./projection.repository"
import { driftOf, expectedRows, planReconcile, type ReconcilePlan } from "./reconcile"

/**
 * The nightly `projection-reconcile` sweep (ADR-0022), for the tenant the job
 * names: recompute the org's `UserOrgIndex` rows from `Membership` and the
 * organization, write what differs in one transaction, and report it. Every
 * membership change already mirrors itself in its own transaction, so drift
 * is a bug — logged as a warning with its shape, never silently absorbed.
 * `ApiTokenIndex` joins when API tokens exist (M8).
 */
@Injectable()
export class ProjectionReconcileService {
  private readonly logger = new Logger(ProjectionReconcileService.name)

  constructor(
    private readonly projections: ProjectionRepository,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async reconcile(): Promise<ReconcilePlan> {
    const orgId = this.tenant.requireOrgId()
    const plan = await this.prisma.transaction(async () => {
      // The projection first, then its source: a membership change committing
      // between the two reads can only make the plan newer than the rows it
      // compares against — never write an older state over a newer one.
      const rows = await this.projections.rows(orgId)
      const source = await this.projections.source(orgId)
      if (source === null) return { create: [], update: [], remove: [] }
      const plan = planReconcile(expectedRows(source), rows)
      await this.projections.create(orgId, plan.create)
      await this.projections.replace(orgId, plan.update)
      await this.projections.remove(orgId, plan.remove)
      return plan
    })
    if (driftOf(plan) > 0) {
      this.logger.warn({
        msg: "projection drift repaired",
        orgId,
        created: plan.create.length,
        updated: plan.update.length,
        removed: plan.remove.length,
      })
    }
    return plan
  }
}

@Processor("projection-reconcile", { autorun: false })
export class ProjectionReconcileProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: ProjectionReconcileService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    const plan = await runJob({ orgId }, "job:projection-reconcile", "recompute the org picker's rows", () => this.service.reconcile())
    return driftOf(plan)
  }
}
