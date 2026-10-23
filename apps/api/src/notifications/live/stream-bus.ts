import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"
import {
  agentVisibilitySchema,
  idSchema,
  notificationEventSchema,
  ticketStatusSchema,
  ticketTypeSchema,
  ticketUpdatedEventSchema,
  bulkProgressEventSchema,
} from "@patchgrid/contracts"
import Redis from "ioredis"
import { z } from "zod"

import { type AppConfig, InjectConfig } from "../../config/app-config"
import { RedisService } from "../../redis/redis.service"

/**
 * What crosses the bus between the process that changed something and the
 * processes holding streams (ADR-0008). Internal: it carries the facts each
 * receiving process needs to decide, with no I/O, who may hear it — never
 * sent to a browser as is.
 */
export const streamMessageSchema = z.discriminatedUnion("kind", [
  /** How far a bulk action has got, for the member running it and no one else (ADR-0052). */
  z.object({ kind: z.literal("bulk-progress"), membershipId: idSchema, event: bulkProgressEventSchema }),
  /** One inbox row, for its one recipient — already filtered by `TicketAudience` when it was written. */
  z.object({ kind: z.literal("notification"), membershipId: idSchema, event: notificationEventSchema }),
  /** A ticket changed: every stream whose member may read it gets the event. */
  z.object({
    kind: z.literal("ticket-updated"),
    ticket: z.object({
      type: ticketTypeSchema,
      status: ticketStatusSchema,
      teamId: idSchema.nullable(),
      requesterMembershipId: idSchema,
      assigneeMembershipId: idSchema.nullable(),
      watcherMembershipIds: z.array(idSchema),
    }),
    visibility: agentVisibilitySchema,
    /** `internal` when the change was to an internal note: only those who may read internal notes hear of it. */
    content: z.enum(["ticket", "internal"]),
    event: ticketUpdatedEventSchema,
  }),
])
export type StreamMessage = z.infer<typeof streamMessageSchema>

export type StreamListener = (message: StreamMessage) => void

/** `org:<orgId>:notifications` (TENANCY.md §9). The one place a channel name is built. */
export function channelFor(orgId: string): string {
  return `org:${idSchema.parse(orgId)}:notifications`
}

/**
 * Fan-out between API instances (ADR-0008, ADR-0018): Redis pub/sub, one
 * channel per tenant. A process subscribes to a tenant's channel while it
 * holds at least one stream for that tenant and drops it after the last one
 * closes, so it never even receives another tenant's traffic it has no
 * stream for. A listener is registered against ONE org and only ever called
 * with messages that arrived on that org's channel.
 *
 * Pub/sub ignores Redis's database number: a dev API and the integration
 * specs share channels, and the org in the name is what keeps them apart.
 */
/** A channel this process listens on: who is listening, and the SUBSCRIBE they all wait for. */
type Subscription = { listeners: Set<StreamListener>; ready: Promise<void> }

@Injectable()
export class StreamBus implements OnModuleDestroy {
  private readonly logger = new Logger(StreamBus.name)
  private readonly channels = new Map<string, Subscription>()
  private subscriber: Redis | null = null

  constructor(
    private readonly redis: RedisService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** Never throws: the change it reports has committed, and the stream is a hint (ADR-0008). */
  async publish(orgId: string, message: StreamMessage): Promise<void> {
    try {
      await this.redis.client.publish(channelFor(orgId), JSON.stringify(streamMessageSchema.parse(message)))
    } catch (error) {
      this.logger.warn({ msg: "stream event not published", orgId, kind: message.kind, error: String(error) })
    }
  }

  /**
   * Resolves once the channel is subscribed, with the unsubscribe; rejects if
   * Redis refused. The listener is registered BEFORE the wait, so a stream
   * that leaves while another's SUBSCRIBE is in flight cannot empty the set
   * and unsubscribe a channel someone is about to listen on; and a failed
   * SUBSCRIBE takes its entry with it, so the next stream tries again rather
   * than trusting a channel nobody subscribed.
   */
  async subscribe(orgId: string, listener: StreamListener): Promise<() => void> {
    const channel = channelFor(orgId)
    let entry = this.channels.get(channel)
    if (entry === undefined) {
      const fresh: Subscription = { listeners: new Set(), ready: Promise.resolve() }
      fresh.ready = this.connection()
        .subscribe(channel)
        .then(
          () => undefined,
          (error: unknown) => {
            if (this.channels.get(channel) === fresh) this.channels.delete(channel)
            throw error
          },
        )
      this.channels.set(channel, fresh)
      entry = fresh
    }
    const joined = entry
    joined.listeners.add(listener)
    try {
      await joined.ready
    } catch (error) {
      joined.listeners.delete(listener)
      throw error
    }

    let left = false
    return () => {
      if (left) return
      left = true
      joined.listeners.delete(listener)
      if (joined.listeners.size > 0 || this.channels.get(channel) !== joined) return
      this.channels.delete(channel)
      // Sent now, in order: a SUBSCRIBE issued after this one wins.
      void this.connection()
        .unsubscribe(channel)
        .catch((error: unknown) => this.logger.warn({ msg: "unsubscribe failed", channel, error: String(error) }))
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.channels.clear()
    this.subscriber?.disconnect()
    this.subscriber = null
  }

  /** A connection in subscriber mode can do nothing else, so it is its own, opened on first use. */
  private connection(): Redis {
    if (this.subscriber !== null) return this.subscriber
    const subscriber = new Redis(this.config.REDIS_URL, {
      // Fail a SUBSCRIBE in seconds during an outage instead of holding the stream open on nothing.
      maxRetriesPerRequest: 2,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    })
    subscriber.on("error", (error: Error) => this.logger.warn(`stream subscriber: ${error.message}`))
    subscriber.on("message", (channel: string, raw: string) => this.receive(channel, raw))
    this.subscriber = subscriber
    return subscriber
  }

  private receive(channel: string, raw: string): void {
    const entry = this.channels.get(channel)
    if (entry === undefined) return
    let parsed: ReturnType<typeof streamMessageSchema.safeParse>
    try {
      parsed = streamMessageSchema.safeParse(JSON.parse(raw))
    } catch {
      parsed = streamMessageSchema.safeParse(undefined)
    }
    if (!parsed.success) {
      this.logger.warn({ msg: "unreadable stream message dropped", channel })
      return
    }
    for (const listener of entry.listeners) {
      // One stream's failure is not every other stream's.
      try {
        listener(parsed.data)
      } catch (error) {
        this.logger.warn({ msg: "stream listener failed", channel, error: String(error) })
      }
    }
  }
}
