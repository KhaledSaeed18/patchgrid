import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"

import { formatTicketNumber } from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../common/clock/clock"
import { PublicUrls } from "../common/urls"
import { type AfterCommit, type EventConsumer, EventConsumers } from "../events/consumer"
import { Outbox } from "../events/outbox"
import { TransientFailure } from "../events/relay"
import type { StoredEvent } from "../events/repositories/outbox.repository"
import { MailService } from "../mail/mail.service"
import { TicketAudience } from "./audience"
import { StreamBus } from "./live/stream-bus"
import { deliveriesFor, type Mailing, mailingsFor, type Person, type TicketCircle } from "./fan-out"
import { type NotifyEvent, notifyEventSchema } from "./notify-events"
import { type AddedNotification, NotificationRepository } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"

/** One inbox row written for one person — what the live stream announces. */
export type Delivered = { person: Person; row: AddedNotification }

/** What one event wrote, and what is left to do once it has committed. */
export type Written = { circle: TicketCircle; delivered: Delivered[]; mailings: Mailing[] }

/** The event types the `notify` consumer reads; the log carries others it skips. */
const NOTIFY_TYPES: ReadonlySet<string> = new Set(notifyEventSchema.options.map((o) => o.shape.kind.value))

/**
 * How a service says what happened (ADR-0018, ADR-0049): inside the
 * transaction that made it happen, as events in the tenant's outbox. The
 * `notify` consumer reads them from there, so a notification exists exactly
 * when its change does — no queue between the commit and the inbox to lose
 * one or repeat it.
 */
@Injectable()
export class Notifier {
  constructor(private readonly outbox: Outbox) {}

  async notify(orgId: string, event: NotifyEvent): Promise<void> {
    await this.notifyAll(orgId, [event])
  }

  async notifyAll(orgId: string, events: readonly NotifyEvent[]): Promise<void> {
    await this.outbox.append(
      orgId,
      events.map((event) => ({ type: event.kind, payload: event })),
    )
  }
}

/**
 * Turns one event into inbox rows and emails, inside the tenant the job
 * names: loads the ticket's people, lets `deliveriesFor` decide, keeps only
 * those who may read the ticket, writes the rows with their de-duplication,
 * and queues the emails `mailingsFor` allows — before the cursor commits, so
 * an email is at least once (ADR-0049 erratum, 2026-10-23). Returns what it
 * delivered in-app, for the live stream.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name)

  constructor(
    private readonly circles: TicketCircleRepository,
    private readonly notifications: NotificationRepository,
    private readonly audience: TicketAudience,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /**
   * Inside the consumer's transaction (ADR-0049): the reads see one state, the
   * rows land with the cursor that consumed the event, and the raw upsert runs
   * where the tenant setting is applied, which RLS insists on. `null` when the
   * ticket is gone.
   */
  async write(orgId: string, event: NotifyEvent, eventId: string): Promise<Written | null> {
    return this.writeRows(orgId, event, eventId)
  }

  /**
   * Still inside the consumer's transaction: the emails the rows allow, queued
   * before the cursor that consumed their event commits. A refusal rolls the
   * batch back to be retried — as the job's failure, never the event's — so
   * nothing is lost; a commit that fails after the queue accepted can send one
   * twice, and each job's id, the event and the person, keeps that to the
   * moment the first is still queued.
   */
  async queueMail(orgId: string, written: readonly Written[]): Promise<void> {
    try {
      await this.mail.enqueueAll(written.flatMap(({ circle, mailings }) => this.jobsFor(orgId, circle, mailings)))
    } catch (error) {
      throw new TransientFailure(`notification email not queued: ${String(error)}`, { cause: error })
    }
  }

  private async writeRows(orgId: string, event: NotifyEvent, eventId: string): Promise<Written | null> {
    const circle = await this.circles.load(orgId, event.ticketId, event.actorMembershipId)
    if (circle === null) return null
    const ticket = { ...circle.ticket, watcherMembershipIds: new Set(circle.watchers.map((w) => w.membershipId)) }
    // A notification about a ticket is a read of it: nobody hears about one
    // they could not open, nor about an internal note they could not see.
    const deliveries = deliveriesFor(event, circle).filter((d) =>
      this.audience.mayRead(orgId, d.person, ticket, circle.org.visibility, d.type === "COMMENT_INTERNAL" ? "internal" : "ticket"),
    )
    const inApp = deliveries.filter((d) => d.channels.inApp)
    const rows = await this.notifications.addMany(
      orgId,
      inApp.map((d) => ({
        userId: d.person.userId,
        membershipId: d.person.membershipId,
        type: d.type,
        title: d.title,
        body: null,
        ticketId: circle.ticket.id,
        dedupeKey: d.dedupeKey,
      })),
      this.clock.now(),
    )
    const byMember = new Map(inApp.map((d) => [d.person.membershipId, d.person]))
    const delivered = rows.flatMap((row) => {
      const person = byMember.get(row.membershipId)
      return person === undefined ? [] : [{ person, row }]
    })
    const written = new Map(rows.map((row) => [row.membershipId, row]))
    return { circle, delivered, mailings: mailingsFor(circle, deliveries, written, eventId) }
  }

  private jobsFor(orgId: string, circle: TicketCircle, mailings: readonly Mailing[]) {
    const { org, ticket } = circle
    return mailings.map((m) => ({
      entityId: m.entityId,
      job: {
        kind: "ticket-notification" as const,
        to: m.person.email,
        orgId,
        fromName: org.name,
        params: {
          orgName: org.name,
          headline: m.headline,
          reason: m.reason,
          ticketUrl: this.urls.workspace(org.slug, `/tickets/${ticket.id}`),
          preferencesUrl: this.urls.workspace(org.slug, "/notifications/preferences"),
          ticketId: ticket.id,
          ticketNumber: formatTicketNumber(ticket.type, ticket.number),
          replyTo: this.urls.inboundAddress(org.slug),
        },
      },
    }))
  }
}

/**
 * The `notify` consumer of the tenant log (ADR-0049). Each event's inbox rows
 * are written, and its emails queued, in the transaction that moves the cursor
 * past it: the rows exactly once, the emails at least once. Once that commits,
 * each recipient's open streams hear of their rows. Events of other types are
 * skipped; an event of a notify type that does not parse is a bug, and fails
 * until it is parked.
 */
@Injectable()
export class NotifyConsumer implements EventConsumer, OnModuleInit {
  readonly name = "notify" as const

  constructor(
    private readonly consumers: EventConsumers,
    private readonly service: NotifyService,
    private readonly bus: StreamBus,
  ) {}

  onModuleInit(): void {
    this.consumers.register(this)
  }

  async handle(orgId: string, events: readonly StoredEvent[]): Promise<AfterCommit> {
    const written: Written[] = []
    for (const stored of events) {
      if (!NOTIFY_TYPES.has(stored.type)) continue
      const event = notifyEventSchema.parse(stored.payload)
      const outcome = await this.service.write(orgId, event, stored.id)
      if (outcome !== null) written.push(outcome)
    }
    await this.service.queueMail(orgId, written)
    return async () => {
      await Promise.all(
        written.flatMap(({ delivered }) =>
          delivered.map(({ person, row }) =>
            this.bus.publish(orgId, {
              kind: "notification",
              membershipId: person.membershipId,
              event: { id: row.id, type: row.type, title: row.title, ticketId: row.ticketId },
            }),
          ),
        ),
      )
    }
  }
}
