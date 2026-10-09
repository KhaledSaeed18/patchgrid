import { z } from "zod"

import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"
import { impactSchema, prioritySchema, urgencySchema } from "./priority.ts"
import { type TicketType, ticketTypeSchema } from "./ticket-number.ts"

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

/**
 * The ticket on the wire (DOMAIN.md, RBAC.md §7). `priority` is the server's
 * answer and is refused on every request (CLAUDE.md: priority is computed);
 * the request schemas are strict, so an unexpected field is a 400 rather
 * than silently dropped.
 */
const titleSchema = z.string().trim().min(1).max(200)
const descriptionSchema = z.string().trim().min(1).max(20_000)

export const commentInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  visibility: commentVisibilitySchema,
})
export type CommentInput = z.infer<typeof commentInputSchema>

export const createTicketRequestSchema = z.strictObject({
  /** Problems and Changes are raised by agents, with their milestone. */
  type: z.enum(["INCIDENT", "SERVICE_REQUEST"]),
  title: titleSchema,
  description: descriptionSchema,
  impact: impactSchema,
  urgency: urgencySchema,
  categoryId: idSchema.optional(),
  /** Raising it for someone else needs `ticket:create_on_behalf`. */
  requesterMembershipId: idSchema.optional(),
})
export type CreateTicketRequest = z.infer<typeof createTicketRequestSchema>

/** Every edit carries the version it was made against; a mismatch is 409 `stale-write`. */
export const updateTicketRequestSchema = z
  .strictObject({
    version: z.int().positive(),
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    impact: impactSchema.optional(),
    urgency: urgencySchema.optional(),
    categoryId: idSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { error: "must change at least one field" })
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>

/** Reassignment, always allowed to agents and audited (DOMAIN.md §5). `null` clears. */
export const assignTicketRequestSchema = z
  .strictObject({
    version: z.int().positive(),
    assigneeMembershipId: idSchema.nullable().optional(),
    teamId: idSchema.nullable().optional(),
  })
  .refine((v) => v.assigneeMembershipId !== undefined || v.teamId !== undefined, {
    error: "must set an assignee, a team, or both",
  })
export type AssignTicketRequest = z.infer<typeof assignTicketRequestSchema>

/** `POST /tickets/:id/transitions` (ADR-0006). */
export const transitionRequestSchema = z.strictObject({
  action: ticketActionSchema,
  version: z.int().positive(),
  /** Required by `wait`, `resolve` and cancelling a worked ticket, in public. */
  comment: commentInputSchema.optional(),
  /** For `assign`. */
  assigneeMembershipId: idSchema.optional(),
  teamId: idSchema.optional(),
})
export type TransitionRequest = z.infer<typeof transitionRequestSchema>

const personSchema = z.object({ membershipId: idSchema, displayName: z.string() })

export const clockSchema = z.object({
  due: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  breached: z.boolean(),
  paused: z.boolean(),
})

/** Which fields this actor may edit and what else they may do, on THIS ticket (RBAC.md §7). */
export const ticketCapabilitiesSchema = z.object({
  editableFields: z.array(z.enum(["title", "description", "impact", "urgency", "categoryId"])),
  canAssign: z.boolean(),
  canCommentPublic: z.boolean(),
  canCommentInternal: z.boolean(),
  canReadInternal: z.boolean(),
  canWatch: z.boolean(),
  canAddWatcher: z.boolean(),
  canReadAudit: z.boolean(),
})
export type TicketCapabilities = z.infer<typeof ticketCapabilitiesSchema>

export const ticketSummarySchema = z.object({
  id: idSchema,
  /** `INC-000042`. */
  number: z.string(),
  type: ticketTypeSchema,
  title: z.string(),
  status: ticketStatusSchema,
  priority: prioritySchema,
  requester: personSchema,
  assignee: personSchema.nullable(),
  team: z.object({ id: idSchema, name: z.string() }).nullable(),
  /** The deadline that matters now — response until answered, then resolution — or `null` without a clock. */
  dueAt: z.iso.datetime().nullable(),
  breached: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type TicketSummary = z.infer<typeof ticketSummarySchema>

export const ticketSchema = ticketSummarySchema.extend({
  description: z.string(),
  version: z.int(),
  impact: impactSchema,
  urgency: urgencySchema,
  category: z.object({ id: idSchema, name: z.string() }).nullable(),
  source: ticketSourceSchema,
  reopenCount: z.int(),
  sla: z.object({ response: clockSchema, resolution: clockSchema }).nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  availableActions: z.array(ticketActionSchema),
  capabilities: ticketCapabilitiesSchema,
})
export type Ticket = z.infer<typeof ticketSchema>

/**
 * The lists (ARCHITECTURE.md §Frontend): `mine` is what the actor raised,
 * `assigned` what is theirs to work, `teams` their teams' open work,
 * `open` everything open they may see, `unassigned` the queue with no team.
 */
export const ticketViewSchema = z.enum(["mine", "assigned", "teams", "open", "unassigned"])
export type TicketView = z.infer<typeof ticketViewSchema>

export const ticketListQuerySchema = paginationQuerySchema.extend({
  view: ticketViewSchema.default("mine"),
  status: ticketStatusSchema.optional(),
})
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>

export const ticketPageSchema = pageSchema(ticketSummarySchema)
export type TicketPage = z.infer<typeof ticketPageSchema>

/** The cap on a search (DOMAIN.md §9.1): ranked results do not page, so they narrow instead. */
export const MAX_SEARCH_RESULTS = 100

/**
 * Full-text search over title and description, or a ticket number
 * (`INC-000042`, `#42`, `42`) for a direct hit. The one documented exception
 * to cursor pagination (ADR-0012): ranked, capped, filtered rather than paged.
 */
export const ticketSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    type: ticketTypeSchema.optional(),
    status: ticketStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_RESULTS, { error: `must be at most ${MAX_SEARCH_RESULTS}` })
      .default(25),
  })
  .strict()
export type TicketSearchQuery = z.infer<typeof ticketSearchQuerySchema>

export const ticketSearchResultSchema = z.object({ items: z.array(ticketSummarySchema) })
export type TicketSearchResult = z.infer<typeof ticketSearchResultSchema>

export const commentSchema = z.object({
  id: idSchema,
  author: personSchema.nullable(),
  authorKind: commentAuthorKindSchema,
  /** `null` once deleted: the thread shows that a comment was removed, not what it said. */
  body: z.string().nullable(),
  visibility: commentVisibilitySchema,
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
})
export type Comment = z.infer<typeof commentSchema>

export const editCommentRequestSchema = z.strictObject({ body: z.string().trim().min(1).max(20_000) })

export const watcherSchema = z.object({
  membershipId: idSchema,
  displayName: z.string(),
  /** The requester and the assignee watch without a row and cannot be removed (RBAC.md §5). */
  implicit: z.boolean(),
})
export type Watcher = z.infer<typeof watcherSchema>
