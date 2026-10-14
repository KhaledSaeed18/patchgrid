import { Injectable } from "@nestjs/common"
import type { AuthVerdict, InboundOutcome, TicketType } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

export type SkippedAttachment = { filename: string; reason: string }

export type InboundEmailRow = {
  id: string
  fromAddress: string
  subject: string
  authVerdict: AuthVerdict
  outcome: InboundOutcome
  skippedAttachments: Prisma.JsonValue
  receivedAt: Date
  sender: { id: string; displayName: string } | null
  ticket: { id: string; type: TicketType; number: number } | null
}

const ROW = {
  id: true,
  fromAddress: true,
  subject: true,
  authVerdict: true,
  outcome: true,
  skippedAttachments: true,
  receivedAt: true,
  sender: { select: { id: true, displayName: true } },
  ticket: { select: { id: true, type: true, number: true } },
} satisfies Prisma.InboundEmailSelect

/** `InboundEmail` (ADR-0027). Tenant-owned; every method takes the org. */
@Injectable()
export class InboundEmailRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The message's row, as received — or the row this org already has for its
   * Message-ID: a provider's retry, the same mail twice, or a job that died
   * part-way. The caller acts only on a row still `RECEIVED`.
   */
  async receive(
    orgId: string,
    data: { id: string; messageKey: string; fromAddress: string; subject: string; authVerdict: AuthVerdict; rawStorageKey: string; receivedAt: Date },
  ): Promise<{ id: string; outcome: InboundOutcome }> {
    await this.prisma.db.inboundEmail.createMany({ data: [{ orgId, ...data }], skipDuplicates: true })
    return this.prisma.db.inboundEmail.findUniqueOrThrow({
      where: { orgId_messageKey: { orgId, messageKey: data.messageKey } },
      select: { id: true, outcome: true },
    })
  }

  /**
   * This worker's turn at a message still `RECEIVED`: `processedAt` marks it
   * taken until `staleBefore`, so two deliveries of one message cannot both
   * act on it. `false` when another worker has it.
   */
  async claim(orgId: string, id: string, now: Date, staleBefore: Date): Promise<boolean> {
    const { count } = await this.prisma.db.inboundEmail.updateMany({
      where: { orgId, id, outcome: "RECEIVED", OR: [{ processedAt: null }, { processedAt: { lt: staleBefore } }] },
      data: { processedAt: now },
    })
    return count === 1
  }

  /** A failed attempt lets go, so the retry can take it straight back. */
  async release(orgId: string, rawStorageKey: string): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({ where: { orgId, rawStorageKey, outcome: "RECEIVED" }, data: { processedAt: null } })
  }

  /** What became of it. A ticket only for CREATED and THREADED — the database says so too. */
  async settle(
    orgId: string,
    id: string,
    outcome: {
      outcome: InboundOutcome
      senderMembershipId?: string | null
      ticketId?: string | null
      skippedAttachments?: SkippedAttachment[]
      error?: string | null
      processedAt: Date
    },
  ): Promise<void> {
    await this.prisma.db.inboundEmail.update({ where: { orgId_id: { orgId, id } }, data: outcome })
  }

  /** A message whose processing gave up: `FAILED`, if nothing else became of it first. */
  async failReceived(orgId: string, rawStorageKey: string, error: string, processedAt: Date): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({ where: { orgId, rawStorageKey, outcome: "RECEIVED" }, data: { outcome: "FAILED", error, processedAt } })
  }

  /** This sender's mail to this org since `since` — the per-sender rate limit (ADR-0027 §6). */
  countFrom(orgId: string, fromAddress: string, since: Date): Promise<number> {
    return this.prisma.db.inboundEmail.count({ where: { orgId, fromAddress, receivedAt: { gte: since } } })
  }

  /** Newest first, keyset on (receivedAt, id). */
  page(orgId: string, filter: { outcome?: InboundOutcome; after: { receivedAt: Date; id: string } | null; limit: number }): Promise<InboundEmailRow[]> {
    return this.prisma.db.inboundEmail.findMany({
      where: {
        orgId,
        AND: [
          filter.outcome === undefined ? {} : { outcome: filter.outcome },
          filter.after === null
            ? {}
            : {
                OR: [
                  { receivedAt: { lt: filter.after.receivedAt } },
                  { receivedAt: filter.after.receivedAt, id: { lt: filter.after.id } },
                ],
              },
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: ROW,
    })
  }
}
