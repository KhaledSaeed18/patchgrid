import { Injectable } from "@nestjs/common"
import type { AuthVerdict, InboundOutcome, TicketType } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

export type SkippedAttachment = { filename: string; reason: string }

/** Outcomes where nothing was made of the message. */
const UNACTED: InboundOutcome[] = ["UNAUTHENTICATED", "UNKNOWN_SENDER", "AUTO_REPLY", "RATE_LIMITED", "FAILED"]

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
   *
   * A delivery that passes DMARC takes over a row nothing was done with —
   * refused, unknown, automatic, limited or failed — so a forged copy sent
   * first under a guessed Message-ID cannot shadow the real message, and a
   * genuine one that failed a check once can be delivered again. Returns the
   * raw message the row no longer points at, for the caller to delete.
   */
  async receive(
    orgId: string,
    data: {
      id: string
      messageKey: string
      fromAddress: string
      subject: string
      authVerdict: AuthVerdict
      rawStorageKey: string
      receivedAt: Date
    },
  ): Promise<{ id: string; outcome: InboundOutcome; replacedRawKey: string | null }> {
    await this.prisma.db.inboundEmail.createMany({ data: [{ orgId, ...data }], skipDuplicates: true })
    const row = await this.prisma.db.inboundEmail.findUniqueOrThrow({
      where: { orgId_messageKey: { orgId, messageKey: data.messageKey } },
      select: { id: true, outcome: true, rawStorageKey: true },
    })
    if (data.authVerdict !== "PASS" || !UNACTED.includes(row.outcome)) return { id: row.id, outcome: row.outcome, replacedRawKey: null }
    const { count } = await this.prisma.db.inboundEmail.updateMany({
      where: { orgId, id: row.id, outcome: { in: UNACTED } },
      data: {
        fromAddress: data.fromAddress,
        subject: data.subject,
        authVerdict: "PASS",
        rawStorageKey: data.rawStorageKey,
        receivedAt: data.receivedAt,
        outcome: "RECEIVED",
        senderMembershipId: null,
        skippedAttachments: [],
        error: null,
        processedAt: null,
        rawDeletedAt: null,
      },
    })
    if (count === 0) return { id: row.id, outcome: row.outcome, replacedRawKey: null }
    return { id: row.id, outcome: "RECEIVED", replacedRawKey: row.rawStorageKey === data.rawStorageKey ? null : row.rawStorageKey }
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

  /**
   * The message became a ticket or a reply — written in the transaction that
   * made it, so a retry after a later failure finds it done and never makes
   * a second one.
   */
  async markActed(
    orgId: string,
    id: string,
    acted: { outcome: "CREATED" | "THREADED"; ticketId: string; senderMembershipId: string },
  ): Promise<void> {
    const { count } = await this.prisma.db.inboundEmail.updateMany({ where: { orgId, id, outcome: "RECEIVED" }, data: acted })
    if (count !== 1) throw new Error(`inbound message ${id} was settled by someone else mid-way`)
  }

  /** A failed attempt lets go of its own claim, so the retry can take it straight back. */
  async release(orgId: string, id: string): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({ where: { orgId, id, outcome: "RECEIVED" }, data: { processedAt: null } })
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
  async failReceived(orgId: string, id: string, error: string, processedAt: Date): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({
      where: { orgId, id, outcome: "RECEIVED" },
      data: { outcome: "FAILED", error, processedAt },
    })
  }

  /** Whether the workspace takes mail from addresses that are no member's (ADR-0027 §4) — read now, never cached. */
  async acceptsExternal(orgId: string): Promise<boolean> {
    const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { allowExternalRequesters: true } })
    return org?.allowExternalRequesters === true
  }

  /**
   * This sender's authenticated mail to this org since `since` — the
   * per-sender limit (ADR-0027 §6). Only PASS rows count: a forger choosing
   * someone's address must not be able to use up that person's allowance.
   */
  countFrom(orgId: string, fromAddress: string, since: Date): Promise<number> {
    return this.prisma.db.inboundEmail.count({ where: { orgId, fromAddress, authVerdict: "PASS", receivedAt: { gte: since } } })
  }

  /**
   * Messages no worker will finish: claimed and abandoned (a worker that
   * died mid-way), or never claimed at all. `FAILED`, so the log never shows
   * one waiting forever.
   */
  async failStuck(orgId: string, claimedBefore: Date, receivedBefore: Date, now: Date): Promise<number> {
    const { count } = await this.prisma.db.inboundEmail.updateMany({
      where: {
        orgId,
        outcome: "RECEIVED",
        OR: [{ processedAt: { lt: claimedBefore } }, { processedAt: null, receivedAt: { lt: receivedBefore } }],
      },
      data: { outcome: "FAILED", error: "Processing did not finish", processedAt: now },
    })
    return count
  }

  /** Raw messages past their retention, oldest first. */
  rawPastRetention(orgId: string, before: Date, limit: number): Promise<{ id: string; rawStorageKey: string }[]> {
    return this.prisma.db.inboundEmail.findMany({
      where: { orgId, rawDeletedAt: null, receivedAt: { lt: before }, outcome: { not: "RECEIVED" } },
      orderBy: { receivedAt: "asc" },
      take: limit,
      select: { id: true, rawStorageKey: true },
    })
  }

  async markRawDeleted(orgId: string, ids: readonly string[], now: Date): Promise<void> {
    await this.prisma.db.inboundEmail.updateMany({ where: { orgId, id: { in: [...ids] } }, data: { rawDeletedAt: now } })
  }

  /** Log rows of mail nothing was done with, past their retention — only once their raw message is gone. */
  async removeUnacted(orgId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.db.inboundEmail.deleteMany({
      where: { orgId, outcome: { in: UNACTED }, receivedAt: { lt: before }, rawDeletedAt: { not: null } },
    })
    return count
  }

  /** Newest first, keyset on (receivedAt, id). */
  page(
    orgId: string,
    filter: { outcome?: InboundOutcome; after: { receivedAt: Date; id: string } | null; limit: number },
  ): Promise<InboundEmailRow[]> {
    return this.prisma.db.inboundEmail.findMany({
      where: {
        orgId,
        AND: [
          filter.outcome === undefined ? {} : { outcome: filter.outcome },
          filter.after === null
            ? {}
            : {
                OR: [{ receivedAt: { lt: filter.after.receivedAt } }, { receivedAt: filter.after.receivedAt, id: { lt: filter.after.id } }],
              },
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: ROW,
    })
  }
}
