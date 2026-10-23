import { Injectable, Logger } from "@nestjs/common"
import { type DeadLetter, type DeadLetterList, eventConsumerSchema } from "@patchgrid/contracts"

import { AuditService } from "../../audit/audit.service"
import { ActorService } from "../../auth/actor"
import { PermissionService } from "../../authz/permission.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem, ReplayFailedProblem } from "../../common/problems/problem.exception"
import { PrismaService } from "../../prisma/prisma.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { type AfterCommit, EventConsumers } from "../consumer"
import { isTransient } from "../relay"
import { type DeadLetterRow, DeadLetterRepository } from "../repositories/dead-letter.repository"
import { OutboxRepository } from "../repositories/outbox.repository"

/** A screen of them; more than this parked at once is an incident, and the log says so. */
const LIST_LIMIT = 100

/**
 * What consumers gave up on, and running one through its consumer again
 * (ADR-0049, THREAT-MODEL §8). Replay is a decision, not a retry: an admin
 * makes it once the cause is fixed. It runs the one event through the
 * consumer's own handler, under the consumer's lock, in one transaction with
 * the mark and its audit row; the handler's after-commit work follows. Every
 * consumer is safe to hand an old event: `reporting` recomputes from the
 * ticket as it is now, `notify` writes the inbox rows that were missed, and
 * `webhooks` delivers it with its own id, which receivers de-duplicate on.
 */
@Injectable()
export class DeadLettersService {
  private readonly logger = new Logger(DeadLettersService.name)

  constructor(
    private readonly letters: DeadLetterRepository,
    private readonly outbox: OutboxRepository,
    private readonly consumers: EventConsumers,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(): Promise<DeadLetterList> {
    const orgId = this.manage()
    const rows = await this.prisma.transaction(() => this.letters.list(orgId, LIST_LIMIT))
    return { items: rows.map(toDeadLetter) }
  }

  async replay(id: string): Promise<DeadLetter> {
    const orgId = this.manage()
    try {
      const { replayed, after } = await this.prisma.transaction(async () => {
        const row = await this.letters.lockOne(orgId, id)
        if (row === null) throw new NotFoundProblem()
        if (row.replayedAt !== null) throw new ConflictProblem("This event has already been replayed")
        const consumer = this.consumers.get(eventConsumerSchema.parse(row.consumer))
        await this.outbox.lock(orgId, consumer.name)
        const after = await consumer.handle(orgId, [row.event])
        await this.audit.record(orgId, [
          {
            action: "EVENT_REPLAYED",
            entityType: "EventDeadLetter",
            entityId: id,
            diff: { consumer: row.consumer, eventId: row.event.id, eventType: row.event.type },
          },
        ])
        return { replayed: await this.letters.markReplayed(orgId, id, this.clock.now()), after }
      })
      await this.runAfter(orgId, after)
      return toDeadLetter(replayed)
    } catch (error) {
      // Not the event's failure: the database's own trouble, or there was nothing to replay.
      if (error instanceof NotFoundProblem || error instanceof ConflictProblem || isTransient(error)) throw error
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      await this.prisma.transaction(() => this.letters.recordFailure(orgId, id, message))
      throw new ReplayFailedProblem(message)
    }
  }

  /** As the relay's: the rows committed, so a failure here is logged and never undoes them. */
  private async runAfter(orgId: string, after: AfterCommit): Promise<void> {
    try {
      await after()
    } catch (error) {
      this.logger.error({ msg: "after-commit work of a replay failed", orgId, error: String(error) })
    }
  }

  private manage(): string {
    this.permissions.assert(this.actors.requireTenantActor(), "org:manage_events")
    return this.tenant.requireOrgId()
  }
}

function toDeadLetter(row: DeadLetterRow): DeadLetter {
  return {
    id: row.id,
    consumer: eventConsumerSchema.parse(row.consumer),
    eventId: row.event.id,
    eventType: row.event.type,
    occurredAt: row.event.occurredAt.toISOString(),
    failures: row.failures,
    error: row.error,
    parkedAt: row.parkedAt.toISOString(),
    replayedAt: row.replayedAt?.toISOString() ?? null,
  }
}
