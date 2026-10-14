import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import { supportEpochKey } from "../auth/support/support-token.service"
import { AuditService } from "../audit/audit.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { PlatformAdminRepository } from "../platform/repositories/platform-admin.repository"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { SupportSessionRepository } from "./repositories/support-session.repository"
import { SupportMail } from "./support-mail"

/**
 * Every five minutes, per tenant (ADR-0041): support sessions past their
 * expiry are ended on the record, audited as `SUPPORT_ACCESS_EXPIRED`, their
 * tokens revoked, and the owners told. The guard already refuses an expired
 * session; this is what makes the end visible.
 */
@Injectable()
export class SupportSweepService {
  constructor(
    private readonly sessions: SupportSessionRepository,
    private readonly admins: PlatformAdminRepository,
    private readonly mail: SupportMail,
    private readonly epochs: RevocationEpochService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sweep(): Promise<number> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    let ended = 0
    for (const session of await this.sessions.expiredRunning(orgId, now)) {
      const done = await this.prisma.transaction(async () => {
        if (!(await this.sessions.end(orgId, session.id, "EXPIRED", now))) return false
        await this.audit.record(orgId, [{ action: "SUPPORT_ACCESS_EXPIRED", entityType: "SupportSession", entityId: session.id }], { kind: "system" })
        return true
      })
      if (!done) continue
      ended += 1
      await this.epochs.bump(supportEpochKey(session.id))
      const operator = await this.admins.active(session.platformAdminId)
      await this.mail.tell(orgId, "ended", { id: session.id, operatorName: operator?.name ?? "Patchgrid support" }, "Its time ran out.")
    }
    return ended
  }
}

@Processor("support-sweep", { autorun: false })
export class SupportSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: SupportSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:support-sweep", "end expired support sessions", () => this.service.sweep())
  }
}
