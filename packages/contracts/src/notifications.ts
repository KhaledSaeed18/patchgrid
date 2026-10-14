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
 * (the `dedupeKey`) and `updatedAt` the latest of them; the inbox orders by
 * `updatedAt`, so a burst on an old unread thread brings it back to the top.
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

/**
 * A member's email choices in one workspace, as stored on
 * `Membership.emailPrefs` (DOMAIN.md §8): per notification type, and only the
 * ones turned off need saying — anything absent is on. Preferences live on
 * the membership, not the user: on call at one company, a casual requester at
 * another.
 */
export const emailPrefsSchema = z.partialRecord(notificationTypeSchema, z.boolean())
export type EmailPrefs = z.infer<typeof emailPrefsSchema>

/** `GET /notifications/preferences`: every type spelled out, and whether the workspace sends email at all. */
export const notificationPreferencesSchema = z.object({
  /** The org's kill switch (`Organization.emailNotificationsEnabled`): off, and no notification email goes to anyone. */
  emailEnabledForOrg: z.boolean(),
  email: z.record(notificationTypeSchema, z.boolean()),
})
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>

/** `PATCH /notifications/preferences`: the types to change; the rest stay as they are. */
export const updateNotificationPreferencesSchema = z.strictObject({ email: emailPrefsSchema })
export type UpdateNotificationPreferences = z.infer<typeof updateNotificationPreferencesSchema>

/** What the stored choices mean: on unless turned off. */
export function emailWanted(prefs: EmailPrefs, type: NotificationType): boolean {
  return prefs[type] !== false
}
