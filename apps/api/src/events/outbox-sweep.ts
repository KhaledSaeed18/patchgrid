import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import type { Job } from "bullmq"

import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { readTenantSweep } from "../jobs/sweeps"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type ConsumerName, EventConsumers } from "./consumer"
import { DrainRequests } from "./drain-requests"
import { OutboxRepository } from "./repositories/outbox.repository"

/**
 * The safety net under the wake (ADR-0049): once a minute, per tenant, any
 * consumer with something left to read gets a drain. It catches a notification
 * sent while no listener was connected, and a drain request Redis refused.
 */
@Injectable()
export class OutboxSweepService {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly consumers: EventConsumers,
    private readonly requests: DrainRequests,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  /** Runs inside the tenant; returns the consumers it asked to drain. */
  async sweep(): Promise<ConsumerName[]> {
    const orgId = this.tenant.requireOrgId()
    // One read, one transaction: the raw query needs the tenant setting only a transaction applies.
    const behind = await this.prisma.transaction(async () => {
      const lagging: ConsumerName[] = []
      for (const name of this.consumers.names()) {
        if (await this.outbox.lagging(orgId, name)) lagging.push(name)
      }
      return lagging
    })
    await Promise.all(behind.map((name) => this.requests.request(orgId, name)))
    return behind
  }
}

@Processor("outbox-sweep", { autorun: false })
export class OutboxSweepProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: OutboxSweepService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const { orgId } = readTenantSweep(job)
    return (await runJob({ orgId }, "job:outbox-sweep", "drain consumers that are behind", () => this.service.sweep())).length
  }
}
