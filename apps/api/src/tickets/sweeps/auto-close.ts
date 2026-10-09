import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { AUTO_CLOSE_DAYS } from "@patchgrid/contracts"
import type { Job } from "bullmq"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { runJob } from "../../jobs/dispatcher/run-job"
import { readTenantSweep } from "../../jobs/sweeps"
import { PrismaService } from "../../prisma/prisma.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { TicketRepository } from "../repositories/ticket.repository"

const DAY = 86_400_000
/** Tickets read per batch; a tenant with more takes several. */
const BATCH = 100
/** A sweep that cannot finish in this many batches leaves the rest for the next tick. */
const MAX_BATCHES = 20

/**
 * `RESOLVED` → `CLOSED` once a resolution has stood for `AUTO_CLOSE_DAYS`
 * (DOMAIN.md §2.1), for the tenant the job names. Each close is its own
 * versioned write with its audit entry, attributed to the system: a requester
 * who reopens in the same instant wins, and the sweep skips that ticket.
 */
@Injectable()
export class AutoCloseService {
  private readonly logger = new Logger(AutoCloseService.name)

  constructor(
    private readonly tickets: TicketRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** Runs inside the tenant context; returns how many tickets it closed. */
  async closeExpired(): Promise<number> {
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const cutoff = new Date(now.getTime() - AUTO_CLOSE_DAYS * DAY)
    let closed = 0
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const due = await this.tickets.findResolvedBefore(orgId, cutoff, BATCH)
      for (const ticket of due) {
        const done = await this.prisma.transaction(async () => {
          if (!(await this.tickets.updateVersioned(orgId, ticket.id, ticket.version, { status: "CLOSED", closedAt: now }))) {
            return false
          }
          await this.audit.record(
            orgId,
            [
              {
                action: "TICKET_TRANSITIONED",
                entityType: "Ticket",
                entityId: ticket.id,
                diff: { action: "close", from: "RESOLVED", to: "CLOSED", automatic: true },
              },
            ],
            { kind: "system" },
          )
          return true
        })
        if (done) closed += 1
      }
      if (due.length < BATCH) break
    }
    if (closed > 0) this.logger.log({ msg: "auto-closed resolved tickets", orgId, closed })
    return closed
  }
}

@Processor("auto-close", { autorun: false })
export class AutoCloseProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly autoClose: AutoCloseService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return runJob({ orgId }, "job:auto-close", "close tickets resolved long enough ago", () =>
      this.autoClose.closeExpired(),
    )
  }
}
