import { z } from "zod"

import { idSchema } from "./id.ts"
import { paginationQuerySchema } from "./pagination.ts"

/** What a notification is about (DOMAIN.md §8). Storage twin: Prisma's `NotificationType`. */
export const notificationTypeSchema = z.enum([
  "TICKET_CREATED",
  "TICKET_RAISED_FOR_YOU",
  "TICKET_ASSIGNED",
  "COMMENT_PUBLIC",
  "COMMENT_INTERNAL",
  "STATUS_CHANGED",
  "TICKET_REOPENED",
  "WATCHER_ADDED",
  "SLA_WARNING",
  "SLA_BREACHED",
])
export type NotificationType = z.infer<typeof notificationTypeSchema>

/**
 * One row of the inbox. `count` is how many events a burst collapsed into
 * (the `dedupeKey`); `updatedAt` is the latest of them, and the inbox orders
 * by it.
 */
export const notificationSchema = z.object({
  id: idSchema,
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string().nullable(),
  ticketId: idSchema.nullable(),
  count: z.int().positive(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type Notification = z.infer<typeof notificationSchema>

export const notificationListQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
})
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>

/** A page of the inbox, with the badge's number alongside so the bell needs one call. */
export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.int().nonnegative(),
})
export type NotificationPage = z.infer<typeof notificationPageSchema>

/**
 * The live stream (ADR-0008) — a hint, never the source of truth: a client
 * that misses one reads the table. `notification` is for the recipient's
 * inbox; `ticket-updated` tells a page showing that ticket to refetch, and is
 * only ever sent to someone who may read the ticket.
 */
export const notificationEventSchema = z.object({
  id: idSchema,
  type: notificationTypeSchema,
  title: z.string(),
  ticketId: idSchema.nullable(),
})
export type NotificationEvent = z.infer<typeof notificationEventSchema>

export const ticketUpdatedEventSchema = z.object({ ticketId: idSchema, updatedAt: z.iso.datetime() })
export type TicketUpdatedEvent = z.infer<typeof ticketUpdatedEventSchema>
