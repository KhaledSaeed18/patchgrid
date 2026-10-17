import { Injectable, type OnModuleInit } from "@nestjs/common"
import { idSchema } from "@patchgrid/contracts"
import { z } from "zod"

import { type AfterCommit, type EventConsumer, EventConsumers } from "../events/consumer"
import type { StoredEvent } from "../events/repositories/outbox.repository"
import { factOf } from "./domain/fact"
import { ReportingRepository } from "./repositories/reporting.repository"

const namesTicket = z.object({ ticketId: idSchema })

/**
 * The `reporting` consumer of the tenant log (ADR-0051). It does not interpret
 * events: it refreshes the fact of every ticket a batch names, from the
 * ticket as it is, in one read and one write, in the transaction that moves
 * its cursor. A replayed or unfamiliar event costs a redundant refresh, never a
 * wrong number. Nothing to do after commit.
 */
@Injectable()
export class ReportingConsumer implements EventConsumer, OnModuleInit {
  readonly name = "reporting" as const

  constructor(
    private readonly consumers: EventConsumers,
    private readonly reporting: ReportingRepository,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this)
  }

  async handle(orgId: string, events: readonly StoredEvent[]): Promise<AfterCommit> {
    const ids = new Set<string>()
    for (const event of events) {
      const parsed = namesTicket.safeParse(event.payload)
      if (parsed.success) ids.add(parsed.data.ticketId)
    }
    const tickets = await this.reporting.sources(orgId, [...ids])
    await this.reporting.upsert(orgId, tickets.map(factOf))
    return async () => undefined
  }
}
