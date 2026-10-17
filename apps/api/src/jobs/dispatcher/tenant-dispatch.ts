import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { ORG_DELETION_WINDOW_DAYS } from "@patchgrid/contracts"
import { type Job, type Queue, UnrecoverableError } from "bullmq"
import { z } from "zod"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { jobId } from "../job-id"
import { PURGE_GRACE_HOURS } from "../purge/org-purge"
import { SWEEP_NAMES, SWEEPS, type SweepName, sweepPriority, sweepTick } from "../sweeps"
import { DispatchRepository } from "./repositories/dispatch.repository"
import { runJob } from "./run-job"

export const TENANT_DISPATCH_QUEUE = "tenant-dispatch"

/** A deletion requested at or before this instant is due for the purge (ADR-0043). */
function purgeDateBefore(now: Date): number {
  return now.getTime() - (ORG_DELETION_WINDOW_DAYS * 24 + PURGE_GRACE_HOURS) * 60 * 60_000
}

const dispatchJobSchema = z.object({ orgId: z.null(), sweep: z.enum(SWEEP_NAMES as [SweepName, ...SweepName[]]) })

/**
 * Two-stage sweeps (ADR-0018). A scheduler per sweep puts a platform job on
 * `tenant-dispatch` every interval; this lists the active organizations — the
 * one cross-tenant read — and enqueues one job per tenant on the sweep's own
 * queue. Each of those runs inside its tenant, retries alone, and cannot
 * starve the others.
 */
@Injectable()
export class TenantDispatchService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantDispatchService.name)
  private readonly queues: Record<SweepName, Queue>

  constructor(
    private readonly orgs: DispatchRepository,
    @InjectClock() private readonly clock: Clock,
    @InjectConfig() private readonly config: AppConfig,
    @InjectQueue(TENANT_DISPATCH_QUEUE) private readonly dispatch: Queue,
    @InjectQueue("sla-scan") slaScan: Queue,
    @InjectQueue("auto-close") autoClose: Queue,
    @InjectQueue("attachment-sweep") attachmentSweep: Queue,
    @InjectQueue("inbound-sweep") inboundSweep: Queue,
    @InjectQueue("support-sweep") supportSweep: Queue,
    @InjectQueue("api-token-sweep") apiTokenSweep: Queue,
    @InjectQueue("org-purge") orgPurge: Queue,
    @InjectQueue("retention-sweep") retentionSweep: Queue,
    @InjectQueue("projection-reconcile") projectionReconcile: Queue,
    @InjectQueue("outbox-sweep") outboxSweep: Queue,
    @InjectQueue("webhook-sweep") webhookSweep: Queue,
    @InjectQueue("reporting-reconcile") reportingReconcile: Queue,
  ) {
    this.queues = {
      "reporting-reconcile": reportingReconcile,
      "webhook-sweep": webhookSweep,
      "outbox-sweep": outboxSweep,
      "sla-scan": slaScan,
      "auto-close": autoClose,
      "attachment-sweep": attachmentSweep,
      "inbound-sweep": inboundSweep,
      "support-sweep": supportSweep,
      "api-token-sweep": apiTokenSweep,
      "org-purge": orgPurge,
      "retention-sweep": retentionSweep,
      "projection-reconcile": projectionReconcile,
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.WORKER_MODE === "api") return
    for (const sweep of SWEEP_NAMES) {
      await this.dispatch.upsertJobScheduler(
        sweep,
        { every: SWEEPS[sweep].everyMs },
        { data: { orgId: null, sweep } },
      )
    }
  }

  /** Fans one sweep out to every active organization; returns the orgs it enqueued for. */
  async fanOut(sweep: SweepName): Promise<string[]> {
    const tick = sweepTick(this.clock.now(), SWEEPS[sweep].everyMs)
    const now = this.clock.now()
    const orgs = await runJob({ orgId: null }, "job:tenant-dispatch", `list tenants for ${sweep}`, () =>
      // Every sweep serves active workspaces, except the one that ends the others (ADR-0043).
      sweep === "org-purge" ? this.orgs.listDueForPurge(new Date(purgeDateBefore(now))) : this.orgs.listDispatchable(),
    )
    await this.queues[sweep].addBulk(
      orgs.map((org) => ({
        name: sweep,
        data: { orgId: org.id, tick },
        opts: { jobId: jobId(sweep, org.id, String(tick), "tick"), priority: sweepPriority(org.plan) },
      })),
    )
    this.logger.log({ msg: "sweep dispatched", sweep, tick, tenants: orgs.length })
    return orgs.map((o) => o.id)
  }
}

@Processor(TENANT_DISPATCH_QUEUE, { autorun: false })
export class TenantDispatchProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly dispatch: TenantDispatchService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<void> {
    const parsed = dispatchJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`dispatch job ${String(job.id)} is unreadable`)
    await this.dispatch.fanOut(parsed.data.sweep)
  }
}
