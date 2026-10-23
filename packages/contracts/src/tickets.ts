import { z } from "zod"

import { linkedAssetSchema, MAX_TICKET_ASSETS } from "./assets.ts"
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

/**
 * Each type's statuses, in lifecycle order (DOMAIN.md §2) — the set the
 * database's type/status CHECK enforces, stated once for the app to offer.
 */
export const TICKET_STATUSES_BY_TYPE: Readonly<Record<TicketType, readonly TicketStatus[]>> = {
  INCIDENT: ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING", "RESOLVED", "CLOSED", "CANCELLED"],
  SERVICE_REQUEST: ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING", "RESOLVED", "CLOSED", "CANCELLED"],
  PROBLEM: ["NEW", "ASSIGNED", "IN_PROGRESS", "KNOWN_ERROR", "RESOLVED", "CLOSED", "CANCELLED"],
  CHANGE: ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "IN_PROGRESS", "IMPLEMENTED", "ROLLED_BACK", "CLOSED", "CANCELLED"],
}

/**
 * Still being worked, of any type: what a queue shows when no status is
 * asked for. A resolved incident, a resolved problem and a change carried
 * out are done; everything before them is open.
 */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING",
  "KNOWN_ERROR",
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
]

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

/** How risky a Change is judged to be (DOMAIN.md §2.3). Storage twin: Prisma's `ChangeRisk`. */
export const changeRiskSchema = z.enum(["LOW", "MEDIUM", "HIGH"])
export type ChangeRisk = z.infer<typeof changeRiskSchema>

const longTextSchema = z.string().trim().min(1).max(20_000)

/** A Problem's own fields (ADR-0002). Each may be set or cleared (`null`) while it is worked. */
export const problemFieldsInputSchema = z.strictObject({
  rootCause: longTextSchema.nullable().optional(),
  workaround: longTextSchema.nullable().optional(),
})
export type ProblemFieldsInput = z.infer<typeof problemFieldsInputSchema>

/** A Change's plan (DOMAIN.md §2.3): optional while `DRAFT`, all required to `submit`. */
export const changeFieldsInputSchema = z.strictObject({
  plannedStart: z.iso.datetime().nullable().optional(),
  plannedEnd: z.iso.datetime().nullable().optional(),
  risk: changeRiskSchema.nullable().optional(),
  implementationPlan: longTextSchema.nullable().optional(),
  rollbackPlan: longTextSchema.nullable().optional(),
  /** Required by `complete` and `rollback`. */
  outcomeNotes: longTextSchema.nullable().optional(),
})
export type ChangeFieldsInput = z.infer<typeof changeFieldsInputSchema>

/** Linked tickets a create takes with it — at most this many at once. */
export const MAX_CREATE_LINKS = 50

export const createTicketRequestSchema = z.strictObject({
  /** Problems and Changes are raised by agents (RBAC.md §6). */
  type: ticketTypeSchema,
  title: titleSchema,
  description: descriptionSchema,
  impact: impactSchema,
  urgency: urgencySchema,
  categoryId: idSchema.optional(),
  /** Raising it for someone else needs `ticket:create_on_behalf`. */
  requesterMembershipId: idSchema.optional(),
  /** A Problem only. */
  problem: problemFieldsInputSchema.optional(),
  /** A Change only. */
  change: changeFieldsInputSchema.optional(),
  /** "Create a Problem from these incidents": each is linked `CAUSED_BY` the new Problem. */
  causedIncidentIds: z.array(idSchema).min(1).max(MAX_CREATE_LINKS).optional(),
  /** "Create a Change from this Problem": the Problem is linked `RESOLVED_BY` the new Change. */
  resolvesProblemId: idSchema.optional(),
  /** The assets it is about. Each must be one the actor can see — a requester's own. */
  assetIds: z.array(idSchema).min(1).max(MAX_TICKET_ASSETS).optional(),
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
    /** A Problem's details — the ticket's version covers them too. */
    problem: problemFieldsInputSchema.optional(),
    /** A Change's plan and outcome. */
    change: changeFieldsInputSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { error: "must change at least one field" })
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>

/** Reassignment, always allowed to agents and audited (DOMAIN.md §5). `null` clears. */
export const assignTicketRequestSchema = z
  .strictObject({
    version: z.int().positive(),
    assigneeMembershipId: idSchema.nullable().optional(),
    teamId: idSchema.nullable().optional(),
    /**
     * The outgoing assignee, handing the ticket on, keeps hearing of it as an
     * explicit watcher (DOMAIN.md §8). Only theirs to ask for.
     */
    keepWatching: z.boolean().optional(),
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
  /**
   * A soft block, retried (CLAUDE.md: no warnings channel): starting a Change
   * more than an hour before its window is a 409 `change-window-early` unless
   * this is `true`.
   */
  confirm: z.literal(true).optional(),
})
export type TransitionRequest = z.infer<typeof transitionRequestSchema>

const personSchema = z.object({ membershipId: idSchema, displayName: z.string() })

export const clockSchema = z.object({
  due: z.iso.datetime().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  breached: z.boolean(),
  paused: z.boolean(),
})

export const PROBLEM_FIELDS = ["rootCause", "workaround"] as const
export const CHANGE_PLAN_FIELDS = ["plannedStart", "plannedEnd", "risk", "implementationPlan", "rollbackPlan"] as const
export const editableFieldSchema = z.enum([
  "title",
  "description",
  "impact",
  "urgency",
  "categoryId",
  ...PROBLEM_FIELDS,
  ...CHANGE_PLAN_FIELDS,
  "outcomeNotes",
])
export type EditableField = z.infer<typeof editableFieldSchema>

/** Which fields this actor may edit and what else they may do, on THIS ticket (RBAC.md §7). */
export const ticketCapabilitiesSchema = z.object({
  /**
   * The core fields, then a Problem's or Change's own — named one by one,
   * because which of a Change's fields are open depends on where it is (the
   * plan while `DRAFT`, the outcome while it is carried out) and the UI must
   * not work that out for itself.
   */
  editableFields: z.array(editableFieldSchema),
  /** Links to and from this ticket may be added and removed. */
  canLink: z.boolean(),
  /** Files may be attached to the ticket and its comments. */
  canUploadAttachment: z.boolean(),
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
  /** What a bulk action sends back for this row (ADR-0052): the version the list showed. */
  version: z.int().positive(),
  /** How it arrived — an email-raised ticket says so in the queue. */
  source: ticketSourceSchema,
  /** `external`: someone outside the workspace, by email only (ADR-0027 §4) — the queue badges them. */
  requester: personSchema.extend({ external: z.boolean() }),
  assignee: personSchema.nullable(),
  team: z.object({ id: idSchema, name: z.string() }).nullable(),
  /** The deadline that matters now — response until answered, then resolution — or `null` without a clock. */
  dueAt: z.iso.datetime().nullable(),
  breached: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type TicketSummary = z.infer<typeof ticketSummarySchema>

export const problemFieldsSchema = z.object({
  rootCause: z.string().nullable(),
  workaround: z.string().nullable(),
  knownErrorAt: z.iso.datetime().nullable(),
})
export type ProblemFields = z.infer<typeof problemFieldsSchema>

export const approvalDecisionSchema = z.enum(["APPROVED", "REJECTED"])
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

/** One decision on a Change; a rejected and resubmitted Change collects several. */
export const changeApprovalSchema = z.object({
  id: idSchema,
  approver: personSchema,
  decision: approvalDecisionSchema,
  /** The documented last-approver case (DOMAIN.md §2.3, rule 3), labelled as such. */
  selfApproved: z.boolean(),
  reason: z.string().nullable(),
  decidedAt: z.iso.datetime(),
})
export type ChangeApproval = z.infer<typeof changeApprovalSchema>

export const changeFieldsSchema = z.object({
  plannedStart: z.iso.datetime().nullable(),
  plannedEnd: z.iso.datetime().nullable(),
  risk: changeRiskSchema.nullable(),
  implementationPlan: z.string().nullable(),
  rollbackPlan: z.string().nullable(),
  outcomeNotes: z.string().nullable(),
  /** Newest first. */
  approvals: z.array(changeApprovalSchema),
})
export type ChangeFields = z.infer<typeof changeFieldsSchema>

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
  /** Present on a Problem, `null` otherwise. */
  problem: problemFieldsSchema.nullable(),
  /** Present on a Change, `null` otherwise. */
  change: changeFieldsSchema.nullable(),
  /** The assets it is about (DOMAIN.md §9.3), by name. */
  assets: z.array(linkedAssetSchema),
})
export type Ticket = z.infer<typeof ticketSchema>

/**
 * A link as read from one ticket (DOMAIN.md §1). Stored once in its canonical
 * direction; each end reads it its own way — `CAUSED_BY` from the incident is
 * `CAUSES` from the problem.
 */
/** How a link is stored, in its canonical direction (DOMAIN.md §1). Storage twin: Prisma's `LinkRelation`. */
export const linkRelationSchema = z.enum(["CAUSED_BY", "RELATES_TO", "RESOLVED_BY", "DUPLICATE_OF"])
export type LinkRelation = z.infer<typeof linkRelationSchema>

export const linkKindSchema = z.enum(["CAUSED_BY", "CAUSES", "RESOLVED_BY", "RESOLVES", "DUPLICATE_OF", "HAS_DUPLICATE", "RELATES_TO"])
export type LinkKind = z.infer<typeof linkKindSchema>

/**
 * The readings a ticket of each type can start a link with (DOMAIN.md §1's
 * table): an incident is caused by a problem, a problem resolved by a
 * change, a duplicate only of its own type, and anything relates to
 * anything. The API decides every link; this lets a form offer only what it
 * would accept, and a test holds the two together.
 */
export const LINK_KINDS_FROM: Readonly<Record<TicketType, readonly LinkKind[]>> = {
  INCIDENT: ["CAUSED_BY", "DUPLICATE_OF", "HAS_DUPLICATE", "RELATES_TO"],
  SERVICE_REQUEST: ["DUPLICATE_OF", "HAS_DUPLICATE", "RELATES_TO"],
  PROBLEM: ["CAUSES", "RESOLVED_BY", "RELATES_TO"],
  CHANGE: ["RESOLVES", "RELATES_TO"],
}

export const ticketLinkSchema = z.object({
  id: idSchema,
  kind: linkKindSchema,
  ticket: z.object({
    id: idSchema,
    number: z.string(),
    type: ticketTypeSchema,
    title: z.string(),
    status: ticketStatusSchema,
  }),
  createdAt: z.iso.datetime(),
})
export type TicketLink = z.infer<typeof ticketLinkSchema>

/** `POST /tickets/:id/links`: "this ticket <kind> that one", read from this ticket. */
export const createLinkRequestSchema = z.strictObject({ kind: linkKindSchema, ticketId: idSchema })
export type CreateLinkRequest = z.infer<typeof createLinkRequestSchema>

/**
 * The lists (ARCHITECTURE.md §Frontend): `mine` is what the actor raised,
 * `assigned` what is theirs to work, `teams` their teams' open work,
 * `open` everything open they may see, `unassigned` the queue with no team,
 * `approvals` the Changes awaiting a decision this actor may make.
 */
/** `all` is every ticket the actor can read, in any status — an asset's history, not a queue. */
export const ticketViewSchema = z.enum(["mine", "assigned", "teams", "open", "unassigned", "approvals", "all"])
export type TicketView = z.infer<typeof ticketViewSchema>

/**
 * The orders a list supports. Only creation time has an index behind it
 * (ARCHITECTURE.md: a sort without a matching index is not a sort option), and
 * the `(orgId, createdAt, id)` index serves both directions.
 */
export const ticketSortSchema = z.enum(["newest", "oldest"])
export type TicketSort = z.infer<typeof ticketSortSchema>

export const ticketListQuerySchema = paginationQuerySchema.extend({
  view: ticketViewSchema.default("mine"),
  /** The per-type queues. */
  type: ticketTypeSchema.optional(),
  status: ticketStatusSchema.optional(),
  /** Computed priority: what "my critical tickets" filters on (ADR-0052). */
  priority: prioritySchema.optional(),
  /** Only the tickets raised about this asset (DOMAIN.md §9.3). */
  assetId: idSchema.optional(),
  sort: ticketSortSchema.default("newest"),
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
