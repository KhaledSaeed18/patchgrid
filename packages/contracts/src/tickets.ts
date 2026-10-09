import { z } from "zod"

import type { TicketType } from "./ticket-number.ts"

/**
 * Ticket statuses (DOMAIN.md §2); the types live with their numbers in
 * `ticket-number.ts`. Declared ahead of the M2 ticket tables because
 * the permission matrix reasons about them: a requester may create only the
 * two user-facing types, and may edit their own ticket only while it is `NEW`.
 * The Prisma twins and their parity assertion arrive with the tables.
 */

/** The two types a requester may raise from the portal (RBAC.md §6). */
export const USER_FACING_TICKET_TYPES = ["INCIDENT", "SERVICE_REQUEST"] as const satisfies readonly TicketType[]

/** The union of every type's statuses; per-type validity is the transition table's (ADR-0002). */
export const ticketStatusSchema = z.enum([
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
  "KNOWN_ERROR",
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "IMPLEMENTED",
  "ROLLED_BACK",
])
export type TicketStatus = z.infer<typeof ticketStatusSchema>

/** Where a ticket came from; a token's tickets are `API`, so machine work is never misread (RBAC.md §10). */
export const ticketSourceSchema = z.enum(["PORTAL", "CONSOLE", "EMAIL", "API"])
export type TicketSource = z.infer<typeof ticketSourceSchema>

/** `INTERNAL` never reaches a requester (DOMAIN.md §7). */
export const commentVisibilitySchema = z.enum(["PUBLIC", "INTERNAL"])
export type CommentVisibility = z.infer<typeof commentVisibilitySchema>

export const commentAuthorKindSchema = z.enum(["MEMBER", "SERVICE", "SYSTEM", "AUTOMATION"])
export type CommentAuthorKind = z.infer<typeof commentAuthorKindSchema>

/**
 * Every action the transitions endpoint accepts (ADR-0006, DOMAIN.md §2).
 * Which of them a given ticket offers is the server's answer in
 * `availableActions`, never re-derived by a client.
 */
export const ticketActionSchema = z.enum([
  "assign",
  "start",
  "wait",
  "resume",
  "resolve",
  "close",
  "reopen",
  "cancel",
  // Problem and Change, with their milestones:
  "workaround",
  "submit",
  "approve",
  "reject",
  "complete",
  "rollback",
])
export type TicketAction = z.infer<typeof ticketActionSchema>
