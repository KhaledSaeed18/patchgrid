import { Injectable } from "@nestjs/common"

import type { StoredEvent } from "./repositories/outbox.repository"

/** Every consumer of the log, by name. A cursor row is keyed on it, so a name is forever. */
export const CONSUMER_NAMES = ["notify"] as const
export type ConsumerName = (typeof CONSUMER_NAMES)[number]

/** What a consumer does once its cursor has committed: email, the live stream — at least once. */
export type AfterCommit = () => Promise<void>

/**
 * A reader of the tenant log (ADR-0049). `handle` runs inside the transaction
 * that moves the consumer's cursor, in the tenant the events belong to: its
 * database writes commit with the cursor or not at all, which is what makes
 * them exactly-once. Anything outside the database goes in the returned
 * `AfterCommit`. A throw rolls the batch back and the relay narrows it down to
 * the event that fails.
 */
export interface EventConsumer {
  readonly name: ConsumerName
  handle(orgId: string, events: readonly StoredEvent[]): Promise<AfterCommit>
}

/**
 * Where consumers sign up. The module that owns a consumer registers it at
 * init, so the relay never imports the modules it serves.
 */
@Injectable()
export class EventConsumers {
  private readonly byName = new Map<ConsumerName, EventConsumer>()

  register(consumer: EventConsumer): void {
    if (this.byName.has(consumer.name)) throw new Error(`event consumer ${consumer.name} registered twice`)
    this.byName.set(consumer.name, consumer)
  }

  get(name: ConsumerName): EventConsumer {
    const consumer = this.byName.get(name)
    if (consumer === undefined) throw new Error(`no event consumer named ${name}`)
    return consumer
  }

  names(): ConsumerName[] {
    return [...this.byName.keys()]
  }
}
