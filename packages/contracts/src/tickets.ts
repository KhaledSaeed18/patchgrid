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
