import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"
import { idSchema } from "@patchgrid/contracts"

import { type AppConfig, InjectConfig } from "../config/app-config"
import { TenantDispatchService } from "../jobs/dispatcher/tenant-dispatch"
import { DatabaseListener, type Listener, OUTBOX_CHANNEL } from "../prisma/database-listener"
import { EventConsumers } from "./consumer"
import { DrainRequests } from "./drain-requests"

/**
 * The wake (ADR-0049): `outbox_wake()` notifies on commit with the org id, and
 * this turns each notification into a drain request per consumer. Workers
 * only — a process that serves HTTP alone drains nothing.
 *
 * A notification is a hint, never the source of truth. Whatever committed
 * while nobody listened (a worker booting, a connection lost) is caught up at
 * once: every (re)connection fans the outbox sweep out, and boot waits for
 * that fan-out. One for an org that has nothing new costs a drain that reads
 * nothing.
 */
@Injectable()
export class OutboxListener implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxListener.name)
  private listener: Listener | null = null

  constructor(
    private readonly consumers: EventConsumers,
    private readonly requests: DrainRequests,
    private readonly database: DatabaseListener,
    private readonly dispatch: TenantDispatchService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.WORKER_MODE === "api") return
    let booted = false
    this.listener = await this.database.listen(OUTBOX_CHANNEL, {
      onNotify: (payload) => void this.wake(payload),
      onConnect: () => {
        this.logger.log({ msg: "listening for outbox commits" })
        // A reconnection catches up in the background; the first connection is awaited below.
        if (booted) void this.catchUp()
      },
      onError: (error) => this.logger.warn({ msg: "outbox listener connection lost", error: error.message }),
    })
    booted = true
    await this.catchUp()
  }

  /** Asks every tenant's sweep to look now, rather than at its next tick. */
  private async catchUp(): Promise<void> {
    try {
      await this.dispatch.fanOut("outbox-sweep")
    } catch (error) {
      this.logger.warn({ msg: "outbox catch-up not dispatched", error: String(error) })
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.listener?.close()
    this.listener = null
  }

  private async wake(payload: string): Promise<void> {
    const orgId = idSchema.safeParse(payload)
    if (!orgId.success) {
      this.logger.warn({ msg: "outbox wake without an org id", payload: payload.slice(0, 64) })
      return
    }
    await Promise.all(this.consumers.names().map((name) => this.requests.request(orgId.data, name)))
  }
}
