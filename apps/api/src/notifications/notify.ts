import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { type Job, type Queue, UnrecoverableError } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { jobId } from "../jobs/job-id"
import { PrismaService } from "../prisma/prisma.service"
import { TicketAudience } from "./audience"
import { StreamBus } from "./live/stream-bus"
import { deliveriesFor, type Person } from "./fan-out"
import { type NotifyEvent, notifyJobSchema } from "./notify-events"
import { type AddedNotification, NotificationRepository } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"

export const NOTIFY_QUEUE = "notify"

/** One inbox row written for one person — what the live stream announces. */
export type Delivered = { person: Person; row: AddedNotification }

/** One thing to tell: the event, and the entity and discriminator that make its job id. */
export type Notice = { event: NotifyEvent; entityId: string; discriminator: string }

/**
 * After commit, a service says what happened; this queues it (ADR-0018). The
 * job carries the tenant and ids, and a job id that makes a retried request
 * notify once: `notify/<orgId>/<entity>/<what>`.
 */
@Injectable()
export class Notifier {
  private readonly logger = new Logger(Notifier.name)

  constructor(@InjectQueue(NOTIFY_QUEUE) private readonly queue: Queue) {}

  async notify(orgId: string, event: NotifyEvent, entityId: string, discriminator: string): Promise<void> {
    await this.notifyAll(orgId, [{ event, entityId, discriminator }])
  }

  /**
   * Many at once, in one round trip. Never throws: the change it reports has
   * already committed, and a lost notification must not turn a successful
   * request into a 500. The table stays the source of truth for whatever did
   * arrive.
   */
  async notifyAll(orgId: string, notices: readonly Notice[]): Promise<void> {
    if (notices.length === 0) return
    try {
      await this.queue.addBulk(
        notices.map(({ event, entityId, discriminator }) => ({
          name: event.kind,
          data: { orgId, event },
          opts: { jobId: jobId(NOTIFY_QUEUE, orgId, entityId, discriminator) },
        })),
      )
    } catch (error) {
      this.logger.error({ msg: "notifications not queued", orgId, count: notices.length, error: String(error) })
    }
  }
}

/**
 * Turns one event into inbox rows, inside the tenant the job names: loads the
 * ticket's people, lets `deliveriesFor` decide, writes each with its
 * de-duplication. Returns what it delivered, for the live stream.
 */
@Injectable()
export class NotifyService {
  constructor(
    private readonly circles: TicketCircleRepository,
    private readonly notifications: NotificationRepository,
    private readonly audience: TicketAudience,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /**
   * One transaction for the event: the reads see one state, the rows land
   * together — and the raw upsert runs where the tenant setting is applied,
   * which RLS insists on.
   */
  async deliver(orgId: string, event: NotifyEvent): Promise<Delivered[]> {
    return this.prisma.transaction(() => this.write(orgId, event))
  }

  private async write(orgId: string, event: NotifyEvent): Promise<Delivered[]> {
    const circle = await this.circles.load(orgId, event.ticketId, event.actorMembershipId)
    if (circle === null) return []
    const ticket = { ...circle.ticket, watcherMembershipIds: new Set(circle.watchers.map((w) => w.membershipId)) }
    // A notification about a ticket is a read of it: nobody hears about one
    // they could not open, nor about an internal note they could not see.
    const deliveries = deliveriesFor(event, circle).filter((d) =>
      this.audience.mayRead(orgId, d.person, ticket, circle.visibility, d.type === "COMMENT_INTERNAL" ? "internal" : "ticket"),
    )
    const rows = await this.notifications.addMany(
      orgId,
      deliveries.map((d) => ({
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
    const byMember = new Map(deliveries.map((d) => [d.person.membershipId, d.person]))
    return rows.flatMap((row) => {
      const person = byMember.get(row.membershipId)
      return person === undefined ? [] : [{ person, row }]
    })
  }
}

@Processor(NOTIFY_QUEUE, { autorun: false, concurrency: 5 })
export class NotifyProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: NotifyService,
    private readonly bus: StreamBus,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<number> {
    const parsed = notifyJobSchema.safeParse(job.data)
    if (!parsed.success) {
      throw new UnrecoverableError(`notify job ${String(job.id)} is unreadable or names no tenant: ${parsed.error.message}`)
    }
    const { orgId, event } = parsed.data
    const delivered = await runJob({ orgId }, "job:notify", event.kind, () => this.service.deliver(orgId, event))
    // The rows have committed; now each recipient's open streams hear of theirs.
    await Promise.all(
      delivered.map(({ person, row }) =>
        this.bus.publish(orgId, {
          kind: "notification",
          membershipId: person.membershipId,
          event: { id: row.id, type: row.type, title: row.title, ticketId: row.ticketId },
        }),
      ),
    )
    return delivered.length
  }
}
