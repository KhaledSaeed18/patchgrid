import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { type Job, type Queue, UnrecoverableError } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { jobId } from "../jobs/job-id"
import { deliveriesFor, type Person } from "./fan-out"
import { type NotifyEvent, notifyJobSchema } from "./notify-events"
import { NotificationRepository, type NotificationRow } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"

export const NOTIFY_QUEUE = "notify"

/** One inbox row written for one person — what the live stream announces. */
export type Delivered = { person: Person; row: NotificationRow & { inserted: boolean } }

/**
 * After commit, a service says what happened; this queues it (ADR-0018). The
 * job carries the tenant and ids, and a job id that makes a retried request
 * notify once: `notify/<orgId>/<entity>/<what>`.
 */
@Injectable()
export class Notifier {
  private readonly logger = new Logger(Notifier.name)

  constructor(@InjectQueue(NOTIFY_QUEUE) private readonly queue: Queue) {}

  /**
   * Never throws: the change it reports has already committed, and a lost
   * notification must not turn a successful request into a 500. The table
   * stays the source of truth for whatever did arrive.
   */
  async notify(orgId: string, event: NotifyEvent, entityId: string, discriminator: string): Promise<void> {
    try {
      await this.queue.add(event.kind, { orgId, event }, { jobId: jobId(NOTIFY_QUEUE, orgId, entityId, discriminator) })
    } catch (error) {
      this.logger.error({ msg: "notification not queued", orgId, kind: event.kind, error: String(error) })
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
    @InjectClock() private readonly clock: Clock,
  ) {}

  async deliver(orgId: string, event: NotifyEvent): Promise<Delivered[]> {
    const circle = await this.circles.load(orgId, event.ticketId, event.actorMembershipId)
    if (circle === null) return []
    const now = this.clock.now()
    const delivered: Delivered[] = []
    for (const delivery of deliveriesFor(event, circle)) {
      const row = await this.notifications.add(
        orgId,
        {
          userId: delivery.person.userId,
          membershipId: delivery.person.membershipId,
          type: delivery.type,
          title: delivery.title,
          body: null,
          ticketId: circle.ticket.id,
          dedupeKey: delivery.dedupeKey,
        },
        now,
      )
      delivered.push({ person: delivery.person, row })
    }
    return delivered
  }
}

@Processor(NOTIFY_QUEUE, { autorun: false, concurrency: 5 })
export class NotifyProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly service: NotifyService,
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
    return delivered.length
  }
}
