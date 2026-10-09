import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { readTenantSweep } from "../../jobs/sweeps"
import { PrismaService } from "../../prisma/prisma.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { scanSignals, type SlaSignal } from "../domain/sla"
import { TicketRepository } from "../repositories/ticket.repository"

const PAGE = 200
/** A tenant with more running clocks than this finishes on the next tick. */
const MAX_PAGES = 25

/** One flag the scan set, for whoever is told about it after commit. */
export type SlaFlagged = SlaSignal & { ticketId: string }

/**
 * The per-tenant SLA scan (DOMAIN.md §4.3): every running clock in the
 * tenant the job names, the pure `scanSignals` deciding, a conditional write
 * flagging, and the audit entry in the same transaction — `SLA_WARNING` or
 * `SLA_BREACHED`, by the system. Idempotent twice over: the decision reads
 * the flags, and the write re-checks them.
 */
@Injectable()
export class SlaScanService {
  private readonly logger = new Logger(SlaScanService.name)

  constructor(
    private readonly tickets: TicketRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async scan(): Promise<SlaFlagged[]> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const flagged: SlaFlagged[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await this.tickets.findRunningClocks(orgId, after, PAGE)
      for (const row of rows) {
        if (row.slaPolicy === null) continue
        for (const signal of scanSignals(row, row.slaPolicy, now)) {
          const due = signal.clock === "response" ? row.respondBy : row.resolveBy
          const done = await this.prisma.transaction(async () => {
            if (!(await this.tickets.flagSla(orgId, row.id, signal.clock, signal.kind, now))) return false
            await this.audit.record(
              orgId,
              [
                {
                  action: signal.kind === "warning" ? "SLA_WARNING" : "SLA_BREACHED",
                  entityType: "Ticket",
                  entityId: row.id,
                  diff: { clock: signal.clock, due: due?.toISOString() ?? null },
                },
              ],
              { kind: "system" },
            )
            return true
          })
          if (done) flagged.push({ ...signal, ticketId: row.id })
        }
      }
      if (rows.length < PAGE) break
      after = rows.at(-1)?.id ?? null
    }
    if (flagged.length > 0) this.logger.log({ msg: "sla flags set", orgId, flagged: flagged.length })
    return flagged
  }
}

@Processor("sla-scan", { autorun: false })
export class SlaScanProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly sla: SlaScanService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    const flagged = await runJob({ orgId }, "job:sla-scan", "flag sla warnings and breaches", () => this.sla.scan())
    return flagged.length
  }
}
