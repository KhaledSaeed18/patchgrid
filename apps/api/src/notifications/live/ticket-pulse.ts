import { Injectable, Logger } from "@nestjs/common"

import { TicketFactsRepository } from "../repositories/ticket-facts.repository"
import { StreamBus } from "./stream-bus"

/**
 * After commit, a ticket service says "this ticket changed"; every stream
 * whose member may read it is told to refetch (ADR-0008). In-process and
 * cheap — one read and one publish — as ENGINEERING.md asks of an SSE push.
 * Never throws: the change has committed, and the stream is only a hint.
 */
@Injectable()
export class TicketPulse {
  private readonly logger = new Logger(TicketPulse.name)

  constructor(
    private readonly facts: TicketFactsRepository,
    private readonly bus: StreamBus,
  ) {}

  /**
   * `internal` when what changed was an internal note: the ticket itself did
   * not, and that a note was written is not something a requester may learn.
   */
  async changed(orgId: string, ticketId: string, content: "ticket" | "internal" = "ticket"): Promise<void> {
    try {
      const facts = await this.facts.load(orgId, ticketId)
      if (facts !== null) await this.bus.publish(orgId, { kind: "ticket-updated", content, ...facts })
    } catch (error) {
      this.logger.warn({ msg: "ticket pulse lost", orgId, ticketId, error: String(error) })
    }
  }
}
