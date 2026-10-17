import { Injectable } from "@nestjs/common"

import { TenantContextService } from "../tenancy/tenant-context.service"
import { type NewEvent, OutboxRepository } from "./repositories/outbox.repository"

/**
 * How a service says what happened (ADR-0049): inside the transaction that made
 * it happen, so the event exists exactly when the change does. Outside that
 * transaction it refuses: an event written on its own could outlive a change
 * rolled back after it.
 */
@Injectable()
export class Outbox {
  constructor(
    private readonly events: OutboxRepository,
    private readonly tenant: TenantContextService,
  ) {}

  async append(orgId: string, events: readonly NewEvent[]): Promise<void> {
    if (events.length === 0) return
    const tenant = this.tenant.current()
    if (tenant?.inTransaction !== true || tenant.orgId !== orgId) {
      throw new Error("Outbox.append runs inside the transaction, for the tenant, that makes the change it reports")
    }
    await this.events.append(orgId, events)
  }
}
