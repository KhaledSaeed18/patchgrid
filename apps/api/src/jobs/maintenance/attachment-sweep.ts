import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type AppConfig, InjectConfig } from "../../config/app-config"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { runJob } from "../dispatcher/run-job"
import { readTenantSweep } from "../sweeps"

/**
 * The hourly `attachment-sweep` (ARCHITECTURE.md §Background jobs), wired end
 * to end ahead of the work it will do: dispatched per tenant, refused without
 * one, run inside it. Attachments arrive in M5 (ADR-0005); then this deletes
 * `PENDING` uploads older than an hour — the row, the object, and the
 * `storage_bytes` they held — and the scaffold's shape does not change.
 */
@Injectable()
export class AttachmentSweepService {
  constructor(private readonly tenant: TenantContextService) {}

  /** Runs inside the tenant context; returns how many abandoned uploads it removed. */
  async sweep(): Promise<number> {
    // Asserted even with nothing to do, so the scaffold proves its context.
    this.tenant.requireOrgId()
    return 0
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
