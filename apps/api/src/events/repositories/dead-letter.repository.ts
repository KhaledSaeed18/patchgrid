import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"
import type { StoredEvent } from "./outbox.repository"

/** A dead letter with the event it holds back. */
export type DeadLetterRow = {
  id: string
  consumer: string
  failures: number
  error: string
  parkedAt: Date
  replayedAt: Date | null
  event: StoredEvent
}

const ROW = {
  id: true,
  consumer: true,
  failures: true,
  error: true,
  parkedAt: true,
  replayedAt: true,
  event: { select: { id: true, txn: true, type: true, payload: true, occurredAt: true } },
} as const

/** The events consumers gave up on (ADR-0049). Tenant-owned; every method takes the org. */
@Injectable()
export class DeadLetterRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Waiting ones first, then the most recently parked; bounded, as a screen of them is. */
  list(orgId: string, limit: number): Promise<DeadLetterRow[]> {
    return this.prisma.db.eventDeadLetter.findMany({
      where: { orgId },
      orderBy: [{ replayedAt: { sort: "desc", nulls: "first" } }, { parkedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: ROW,
    })
  }

  /** Locked for the replay's transaction, so two admins pressing at once replay it once. */
  async lockOne(orgId: string, id: string): Promise<DeadLetterRow | null> {
    const locked = await this.prisma.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "EventDeadLetter" WHERE "orgId" = ${orgId}::uuid AND id = ${id}::uuid FOR UPDATE`
    if (locked.length === 0) return null
    return this.prisma.db.eventDeadLetter.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  async markReplayed(orgId: string, id: string, at: Date): Promise<DeadLetterRow> {
    return this.prisma.db.eventDeadLetter.update({ where: { orgId_id: { orgId, id } }, data: { replayedAt: at }, select: ROW })
  }

  /** A replay that failed: one more failure, and the newer error. */
  async recordFailure(orgId: string, id: string, error: string): Promise<void> {
    await this.prisma.db.eventDeadLetter.updateMany({ where: { orgId, id, replayedAt: null }, data: { failures: { increment: 1 }, error } })
  }
}
