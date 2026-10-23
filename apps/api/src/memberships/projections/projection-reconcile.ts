import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { readTenantSweep } from "../../jobs/sweeps"
import { ApiTokenIndexRepository } from "../../platform/repositories/api-token-index.repository"
import { UserOrgIndexRepository } from "../../platform/repositories/user-org-index.repository"
import { PrismaService } from "../../prisma/prisma.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { ProjectionSourceRepository } from "./projection-source.repository"
import { driftOf, expectedRows, planReconcile, planTokenReconcile, type ReconcilePlan, type TokenReconcilePlan } from "./reconcile"

/**
 * The nightly `projection-reconcile` sweep (ADR-0022), for the tenant the job
 * names: recompute the org's `UserOrgIndex` rows from `Membership` and the
 * organization, write what differs in one transaction, and report it. Every
 * membership change already mirrors itself in its own transaction, so drift
 * is a bug — logged as a warning with its shape, never silently absorbed.
 * `ApiTokenIndex` is held to `ApiToken` the same way (ADR-0042).
 */
@Injectable()
export class ProjectionReconcileService {
  private readonly logger = new Logger(ProjectionReconcileService.name)

  constructor(
    private readonly sources: ProjectionSourceRepository,
    private readonly orgIndex: UserOrgIndexRepository,
    private readonly tokenIndex: ApiTokenIndexRepository,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  async reconcile(): Promise<{ people: ReconcilePlan; tokens: TokenReconcilePlan }> {
    const orgId = this.tenant.requireOrgId()
    const plan = await this.prisma.transaction(async () => {
      // The projection first, then its source: a membership change committing
      // between the two reads can only make the plan newer than the rows it
      // compares against — never write an older state over a newer one.
      const rows = await this.orgIndex.rowsForOrg(orgId)
      const tokenRows = await this.tokenIndex.rowsForOrg(orgId)
      const source = await this.sources.people(orgId)
      if (source === null) return { people: { create: [], update: [], remove: [] }, tokens: { create: [], update: [], remove: [] } }
      const people = planReconcile(expectedRows(source), rows)
      const tokens = planTokenReconcile(await this.sources.tokens(orgId), tokenRows)
      await this.orgIndex.createForOrg(orgId, people.create)
      await this.orgIndex.replaceForOrg(orgId, people.update)
      await this.orgIndex.removeForOrg(orgId, people.remove)
      await this.tokenIndex.writeForOrg(orgId, tokens)
      return { people, tokens }
    })
    if (driftOf(plan.people) + driftOf(plan.tokens) > 0) {
      this.logger.warn({
        msg: "projection drift repaired",
        orgId,
        created: plan.people.create.length,
        updated: plan.people.update.length,
        removed: plan.people.remove.length,
        tokens: { created: plan.tokens.create.length, updated: plan.tokens.update.length, removed: plan.tokens.remove.length },
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
    const plan = await runJob({ orgId }, "job:projection-reconcile", "recompute the org picker's and the token prefixes' rows", () =>
      this.service.reconcile(),
    )
    return driftOf(plan.people) + driftOf(plan.tokens)
  }
}
