import { InjectQueue } from "@nestjs/bullmq"
import { Injectable, type OnModuleInit } from "@nestjs/common"
import type { WebhookPayload } from "@patchgrid/contracts"
import type { Queue } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AfterCommit, type EventConsumer, EventConsumers } from "../events/consumer"
import type { StoredEvent } from "../events/repositories/outbox.repository"
import { notifyEventSchema } from "../notifications/notify-events"
import { publicEvent, publicTypeOf } from "./domain/public-events"
import { deliveryJob, WEBHOOK_DELIVER_QUEUE } from "./delivery/deliver-job"
import { type NewDelivery, WebhookRepository } from "./repositories/webhook.repository"

/**
 * The `webhooks` consumer of the tenant log (ADR-0050). For each event with a
 * public face, one delivery row per active endpoint that listens for its type,
 * written in the transaction that moves the cursor: each endpoint gets each
 * event exactly once as a row. The payload is fixed here, so every attempt
 * sends the same bytes. The attempts are jobs, queued once the rows commit.
 */
@Injectable()
export class WebhooksConsumer implements EventConsumer, OnModuleInit {
  readonly name = "webhooks" as const

  constructor(
    private readonly consumers: EventConsumers,
    private readonly webhooks: WebhookRepository,
    @InjectQueue(WEBHOOK_DELIVER_QUEUE) private readonly queue: Queue,
    @InjectClock() private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this)
  }

  async handle(orgId: string, events: readonly StoredEvent[]): Promise<AfterCommit> {
    const endpoints = await this.webhooks.activeEndpoints(orgId)
    if (endpoints.length === 0) return async () => undefined

    // Only events some endpoint wants, parsed; the log carries more than the catalogue.
    const wanted = events.flatMap((stored) => {
      const parsed = notifyEventSchema.safeParse(stored.payload)
      if (!parsed.success) return []
      const type = publicTypeOf(parsed.data)
      if (type === null) return []
      const listeners = endpoints.filter((e) => e.eventTypes.includes(type))
      return listeners.length === 0 ? [] : [{ stored, event: parsed.data, listeners }]
    })
    if (wanted.length === 0) return async () => undefined

    const tickets = new Map((await this.webhooks.ticketFacts(orgId, [...new Set(wanted.map((w) => w.event.ticketId))])).map((t) => [t.id, t]))
    const now = this.clock.now()
    const rows: NewDelivery[] = wanted.flatMap(({ stored, event, listeners }) => {
      const ticket = tickets.get(event.ticketId)
      // A ticket gone before its event was read has nothing left to say.
      const data = ticket === undefined ? null : publicEvent(event, ticket)
      if (data === null) return []
      return listeners.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId: stored.id,
        eventType: data.type,
        // The delivery id is the payload's id; it is filled in once the row has one.
        payload: { type: data.type, occurredAt: stored.occurredAt.toISOString(), orgId, data } satisfies Omit<WebhookPayload, "id">,
        nextAttemptAt: now,
      }))
    })
    const created = await this.webhooks.createDeliveries(orgId, rows)
    return async () => {
      await this.queue.addBulk(created.map((d) => deliveryJob(orgId, d.id, "a0", 0)))
    }
  }
}
