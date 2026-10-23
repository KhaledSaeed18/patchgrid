import { Injectable } from "@nestjs/common"
import type { NotificationType } from "@patchgrid/contracts"
import { v7 as uuidv7 } from "uuid"

import { PrismaService } from "../../prisma/prisma.service"

export type NotificationRow = {
  id: string
  type: NotificationType
  title: string
  body: string | null
  ticketId: string | null
  count: number
  readAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type NewNotification = {
  userId: string
  membershipId: string
  type: NotificationType
  title: string
  body: string | null
  ticketId: string | null
  dedupeKey: string | null
}

/** A row as written by `addMany`: whose it is, and whether it is new or a burst folded into one. */
export type AddedNotification = NotificationRow & { membershipId: string; inserted: boolean }

const ROW = {
  id: true,
  type: true,
  title: true,
  body: true,
  ticketId: true,
  count: true,
  readAt: true,
  createdAt: true,
  updatedAt: true,
} as const

/**
 * Tenant-owned; every method takes the org, and every read and write of an
 * inbox also takes its owner — a member reads and marks only their own rows
 * (`notification:*` is `self`, RBAC.md §6).
 */
@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Most recently active first, keyset-paged on (updatedAt, id) — the
   * `(orgId, userId, updatedAt)` index. A fold moves `updatedAt`, so a burst
   * on an old unread thread brings it back to the top.
   */
  async list(
    orgId: string,
    userId: string,
    filter: { unread: boolean; after: { updatedAt: Date; id: string } | null; limit: number },
  ): Promise<NotificationRow[]> {
    return this.prisma.db.notification.findMany({
      where: {
        orgId,
        userId,
        ...(filter.unread ? { readAt: null } : {}),
        ...(filter.after === null
          ? {}
          : {
              OR: [{ updatedAt: { lt: filter.after.updatedAt } }, { updatedAt: filter.after.updatedAt, id: { lt: filter.after.id } }],
            }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: ROW,
    })
  }

  /**
   * What a reconnecting stream missed (ADR-0008): this member's rows written
   * or folded into after the one the stream last sent, oldest first, capped.
   * Best effort by design — a row committed late can fall behind the mark —
   * which is why the client also re-reads the inbox whenever a stream opens.
   * An id that is not this member's replays nothing.
   */
  async since(orgId: string, userId: string, afterId: string, limit: number): Promise<NotificationRow[]> {
    return this.prisma.transaction(async () => {
      const mark = await this.prisma.db.notification.findFirst({ where: { orgId, userId, id: afterId }, select: { updatedAt: true } })
      if (mark === null) return []
      return this.prisma.db.notification.findMany({
        where: { orgId, userId, updatedAt: { gt: mark.updatedAt } },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit,
        select: ROW,
      })
    })
  }

  /** A page and the badge's number, read in one transaction so they describe the same moment. */
  async page(
    orgId: string,
    userId: string,
    filter: { unread: boolean; after: { updatedAt: Date; id: string } | null; limit: number },
  ): Promise<{ rows: NotificationRow[]; unreadCount: number }> {
    return this.prisma.transaction(async () => {
      const rows = await this.list(orgId, userId, filter)
      return { rows, unreadCount: await this.unreadCount(orgId, userId) }
    })
  }

  async unreadCount(orgId: string, userId: string): Promise<number> {
    return this.prisma.db.notification.count({ where: { orgId, userId, readAt: null } })
  }

  /** `false` when the row is not this member's — or not there at all; the caller cannot tell, and says 404. */
  async markRead(orgId: string, userId: string, id: string, now: Date): Promise<boolean> {
    const owned = await this.prisma.db.notification.findFirst({ where: { orgId, userId, id }, select: { readAt: true } })
    if (owned === null) return false
    if (owned.readAt === null) {
      await this.prisma.db.notification.updateMany({ where: { orgId, userId, id, readAt: null }, data: { readAt: now } })
    }
    return true
  }

  async markAllRead(orgId: string, userId: string, now: Date): Promise<number> {
    const { count } = await this.prisma.db.notification.updateMany({ where: { orgId, userId, readAt: null }, data: { readAt: now } })
    return count
  }

  /**
   * Adds a batch of notifications in one statement — or, for each member who
   * already has an unread one with the same `dedupeKey`, folds into it:
   * `count` up by one, the newer title and body, `updatedAt` now. One
   * statement against the partial unique index, so two bursts racing cannot
   * make two rows and a fan-out to fifty admins is not fifty round trips. The
   * batch must name each member at most once. Raw SQL because Prisma cannot
   * name a partial index as a conflict target — so call it inside
   * `transaction()`, where the tenant setting is applied. Returns the rows the
   * members will see.
   */
  async addMany(orgId: string, notes: readonly NewNotification[], now: Date): Promise<AddedNotification[]> {
    if (notes.length === 0) return []
    return this.prisma.tx.$queryRaw<AddedNotification[]>`
      INSERT INTO "Notification"
        ("id", "orgId", "userId", "membershipId", "type", "title", "body", "ticketId", "dedupeKey", "createdAt", "updatedAt")
      SELECT n."id", ${orgId}::uuid, n."userId", n."membershipId", n."type"::"NotificationType", n."title", n."body",
        n."ticketId", n."dedupeKey", ${now}, ${now}
      FROM unnest(
        ${notes.map(() => uuidv7())}::uuid[],
        ${notes.map((n) => n.userId)}::uuid[],
        ${notes.map((n) => n.membershipId)}::uuid[],
        ${notes.map((n) => n.type)}::text[],
        ${notes.map((n) => n.title)}::text[],
        ${notes.map((n) => n.body)}::text[],
        ${notes.map((n) => n.ticketId)}::uuid[],
        ${notes.map((n) => n.dedupeKey)}::text[]
      ) AS n("id", "userId", "membershipId", "type", "title", "body", "ticketId", "dedupeKey")
      ON CONFLICT ("orgId", "membershipId", "dedupeKey") WHERE "readAt" IS NULL
      DO UPDATE SET
        "count" = "Notification"."count" + 1,
        "title" = EXCLUDED."title",
        "body" = EXCLUDED."body",
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "id", "membershipId", "type", "title", "body", "ticketId", "count", "readAt", "createdAt", "updatedAt",
        (xmax = 0) AS "inserted"
    `
  }
}
