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

  /** Newest first, keyset-paged on (createdAt, id) — the `(orgId, userId, readAt, createdAt)` index. */
  async list(
    orgId: string,
    userId: string,
    filter: { unread: boolean; after: { createdAt: Date; id: string } | null; limit: number },
  ): Promise<NotificationRow[]> {
    return this.prisma.db.notification.findMany({
      where: {
        orgId,
        userId,
        ...(filter.unread ? { readAt: null } : {}),
        ...(filter.after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: filter.after.createdAt } },
                { createdAt: filter.after.createdAt, id: { lt: filter.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: ROW,
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
   * Adds one notification, or — when an unread one with the same `dedupeKey`
   * exists for that member — folds into it: `count` up by one, the newer
   * title and body, `updatedAt` now. One statement against the partial unique
   * index, so two bursts racing cannot make two rows. Raw SQL because Prisma
   * cannot name a partial index as a conflict target. Returns the row the
   * member will see.
   */
  async add(orgId: string, note: NewNotification, now: Date): Promise<NotificationRow & { inserted: boolean }> {
    const [row] = await this.prisma.db.$queryRaw<(NotificationRow & { inserted: boolean })[]>`
      INSERT INTO "Notification"
        ("id", "orgId", "userId", "membershipId", "type", "title", "body", "ticketId", "dedupeKey", "createdAt", "updatedAt")
      VALUES (
        ${uuidv7()}::uuid, ${orgId}::uuid, ${note.userId}::uuid, ${note.membershipId}::uuid,
        ${note.type}::"NotificationType", ${note.title}, ${note.body}, ${note.ticketId}::uuid, ${note.dedupeKey},
        ${now}, ${now}
      )
      ON CONFLICT ("orgId", "membershipId", "dedupeKey") WHERE "readAt" IS NULL
      DO UPDATE SET
        "count" = "Notification"."count" + 1,
        "title" = EXCLUDED."title",
        "body" = EXCLUDED."body",
        "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "id", "type", "title", "body", "ticketId", "count", "readAt", "createdAt", "updatedAt",
        (xmax = 0) AS "inserted"
    `
    if (row === undefined) throw new Error("notification insert returned no row")
    return row
  }
}
