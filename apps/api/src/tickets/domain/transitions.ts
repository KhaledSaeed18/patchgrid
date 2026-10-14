import {
  REOPEN_WINDOW_DAYS,
  type Role,
  type TicketAction,
  type TicketStatus,
  type TicketType,
} from "@patchgrid/contracts"

/**
 * The per-type transition table (DOMAIN.md §2, ADR-0002, ADR-0006) — as data,
 * because the table IS the rule: `from · action · to · who · guards`. Anything
 * not listed is refused with 409. Effects on clocks live in `sla.ts`.
 */

/** Who may perform a row, given what the actor is to THIS ticket. */
export type Who =
  /** Agents and above. */
  | "agent"
  /** The assignee, or an admin and above. */
  | "assignee_or_admin"
  /** The assignee, any agent when there is no assignee yet, or an admin and above. */
  | "worker"
  /** The ticket's own requester, or agents and above. */
  | "requester_or_agent"
  /** A Change's own requester (an agent), or an admin and above (DOMAIN.md §2.3). */
  | "change_owner"
  /**
   * An eligible approver of THIS Change — decided by the service, which must
   * look at who else could approve (DOMAIN.md §2.3), and handed in on the
   * actor's relation.
   */
  | "approver"

/** What the transition demands be said alongside it. */
export type CommentRule = "none" | "public"

export type TransitionRow = {
  from: readonly TicketStatus[]
  action: TicketAction
  to: TicketStatus
  who: Who
  comment: CommentRule
  /** Why a comment is required, for the 400 the client maps onto the field. */
  commentReason?: string
  /** A guard beyond who and the comment; `null` when it passes, else why not. */
  guard?: (ticket: TransitionTicket, now: Date) => string | null
  /**
   * A soft block (CLAUDE.md: no warnings channel): a reason the move needs
   * `confirm: true`, or `null`. It never hides the action.
   */
  confirm?: (ticket: TransitionTicket, now: Date) => string | null
}

/** A Problem's fields a guard reads. */
export type ProblemFacts = { rootCause: string | null; workaround: string | null }
/** A Change's fields a guard reads. */
export type ChangeFacts = {
  plannedStart: Date | null
  plannedEnd: Date | null
  risk: string | null
  implementationPlan: string | null
  rollbackPlan: string | null
  outcomeNotes: string | null
}

export type TransitionTicket = {
  status: TicketStatus
  closedAt: Date | null
  /** Present on a Problem. */
  problem?: ProblemFacts | null
  /** Present on a Change. */
  change?: ChangeFacts | null
}

const DAY = 86_400_000

const withinReopenWindow = (ticket: TransitionTicket, now: Date): string | null =>
  ticket.closedAt !== null && now.getTime() > ticket.closedAt.getTime() + REOPEN_WINDOW_DAYS * DAY
    ? `A ticket can be reopened for ${REOPEN_WINDOW_DAYS} days after it closes; raise a new one and link it`
    : null

/** Incident and Service Request share one table (DOMAIN.md §2.1). */
const INCIDENT_TABLE: readonly TransitionRow[] = [
  { from: ["NEW"], action: "assign", to: "ASSIGNED", who: "agent", comment: "none" },
  { from: ["NEW", "ASSIGNED"], action: "start", to: "IN_PROGRESS", who: "worker", comment: "none" },
  {
    from: ["IN_PROGRESS"],
    action: "wait",
    to: "PENDING",
    who: "assignee_or_admin",
    comment: "public",
    commentReason: "Tell the requester what you are waiting on",
  },
  { from: ["PENDING"], action: "resume", to: "IN_PROGRESS", who: "assignee_or_admin", comment: "none" },
  {
    from: ["IN_PROGRESS"],
    action: "resolve",
    to: "RESOLVED",
    who: "assignee_or_admin",
    comment: "public",
    commentReason: "A resolution note tells the requester what was done",
  },
  { from: ["RESOLVED"], action: "close", to: "CLOSED", who: "requester_or_agent", comment: "none" },
  { from: ["RESOLVED"], action: "reopen", to: "IN_PROGRESS", who: "requester_or_agent", comment: "none" },
  {
    from: ["CLOSED"],
    action: "reopen",
    to: "IN_PROGRESS",
    who: "requester_or_agent",
    comment: "none",
    guard: withinReopenWindow,
  },
  { from: ["NEW"], action: "cancel", to: "CANCELLED", who: "requester_or_agent", comment: "none" },
  {
    from: ["ASSIGNED", "IN_PROGRESS", "PENDING"],
    action: "cancel",
    to: "CANCELLED",
    who: "agent",
    comment: "public",
    commentReason: "Say why the ticket is being cancelled",
  },
]

const HOUR = 3_600_000

const hasWorkaround = (t: TransitionTicket): string | null =>
  isBlank(t.problem?.workaround) ? "Record the workaround before marking this a known error" : null
const hasRootCause = (t: TransitionTicket): string | null =>
  isBlank(t.problem?.rootCause) ? "Record the root cause before resolving the problem" : null

/** Everything `submit` needs (DOMAIN.md §2.3), named so the client can point at what is missing. */
const PLAN: readonly (keyof ChangeFacts)[] = ["plannedStart", "plannedEnd", "implementationPlan", "rollbackPlan", "risk"]
const planComplete = (t: TransitionTicket): string | null => {
  const missing = PLAN.filter((field) => {
    const value = t.change?.[field] ?? null
    return value === null || (typeof value === "string" && isBlank(value))
  })
  return missing.length === 0 ? null : `A change needs its plan before it is submitted: ${missing.join(", ")}`
}
const hasOutcome = (t: TransitionTicket): string | null =>
  isBlank(t.change?.outcomeNotes) ? "Record what happened in the outcome notes first" : null
/** Not before `plannedStart − 1 h` without saying so. */
const windowOpen = (t: TransitionTicket, now: Date): string | null => {
  const start = t.change?.plannedStart ?? null
  return start !== null && now.getTime() < start.getTime() - HOUR
    ? `The change window opens at ${start.toISOString()}; starting now is early`
    : null
}

/** DOMAIN.md §2.2: no `PENDING`, no SLA clocks, never raised by a requester. */
const PROBLEM_TABLE: readonly TransitionRow[] = [
  { from: ["NEW"], action: "assign", to: "ASSIGNED", who: "agent", comment: "none" },
  { from: ["NEW", "ASSIGNED"], action: "start", to: "IN_PROGRESS", who: "worker", comment: "none" },
  { from: ["IN_PROGRESS"], action: "workaround", to: "KNOWN_ERROR", who: "assignee_or_admin", comment: "none", guard: hasWorkaround },
  { from: ["IN_PROGRESS", "KNOWN_ERROR"], action: "resolve", to: "RESOLVED", who: "assignee_or_admin", comment: "none", guard: hasRootCause },
  { from: ["RESOLVED"], action: "close", to: "CLOSED", who: "agent", comment: "none" },
  {
    from: ["NEW", "ASSIGNED", "IN_PROGRESS", "KNOWN_ERROR"],
    action: "cancel",
    to: "CANCELLED",
    who: "agent",
    comment: "public",
    commentReason: "Say why the problem is being cancelled",
  },
]

/** DOMAIN.md §2.3. A rejection returns the Change to `DRAFT`; the decision itself is a `ChangeApproval` row. */
const CHANGE_TABLE: readonly TransitionRow[] = [
  { from: ["DRAFT"], action: "submit", to: "AWAITING_APPROVAL", who: "change_owner", comment: "none", guard: planComplete },
  { from: ["AWAITING_APPROVAL"], action: "approve", to: "APPROVED", who: "approver", comment: "none" },
  {
    from: ["AWAITING_APPROVAL"],
    action: "reject",
    to: "DRAFT",
    who: "approver",
    comment: "public",
    commentReason: "Say why the change is rejected, so it can be fixed and resubmitted",
  },
  { from: ["APPROVED"], action: "start", to: "IN_PROGRESS", who: "worker", comment: "none", confirm: windowOpen },
  { from: ["IN_PROGRESS"], action: "complete", to: "IMPLEMENTED", who: "assignee_or_admin", comment: "none", guard: hasOutcome },
  { from: ["IN_PROGRESS"], action: "rollback", to: "ROLLED_BACK", who: "assignee_or_admin", comment: "none", guard: hasOutcome },
  { from: ["IMPLEMENTED", "ROLLED_BACK"], action: "close", to: "CLOSED", who: "agent", comment: "none" },
  { from: ["DRAFT", "AWAITING_APPROVAL", "APPROVED"], action: "cancel", to: "CANCELLED", who: "change_owner", comment: "none" },
]

export const TRANSITION_TABLES: Readonly<Record<TicketType, readonly TransitionRow[]>> = {
  INCIDENT: INCIDENT_TABLE,
  SERVICE_REQUEST: INCIDENT_TABLE,
  PROBLEM: PROBLEM_TABLE,
  CHANGE: CHANGE_TABLE,
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === ""
}

/**
 * May this actor decide on this Change (DOMAIN.md §2.3)? `eligible` by rule 1
 * or 2; `self` only by rule 3 — an owner with nobody else able to; `none`
 * otherwise and for every other type. Worked out by the service.
 */
export type ApprovalStanding = "eligible" | "self" | "none"

/** What the actor is to this ticket — loaded by the service, decided here. */
export type ActorRelation = {
  role: Role
  isRequester: boolean
  isAssignee: boolean
  ticketHasAssignee: boolean
  approval?: ApprovalStanding
}

const AGENT_ROLES: ReadonlySet<Role> = new Set(["AGENT", "ADMIN", "OWNER"])
const ADMIN_ROLES: ReadonlySet<Role> = new Set(["ADMIN", "OWNER"])

export function mayPerform(who: Who, actor: ActorRelation): boolean {
  switch (who) {
    case "agent":
      return AGENT_ROLES.has(actor.role)
    case "assignee_or_admin":
      return ADMIN_ROLES.has(actor.role) || (AGENT_ROLES.has(actor.role) && actor.isAssignee)
    case "worker":
      return (
        ADMIN_ROLES.has(actor.role) ||
        (AGENT_ROLES.has(actor.role) && (actor.isAssignee || !actor.ticketHasAssignee))
      )
    case "requester_or_agent":
      return AGENT_ROLES.has(actor.role) || actor.isRequester
    case "change_owner":
      return ADMIN_ROLES.has(actor.role) || (AGENT_ROLES.has(actor.role) && actor.isRequester)
    case "approver":
      return actor.approval === "eligible" || actor.approval === "self"
  }
}

/** Self-approval is rule 3's alone: an approval, never a rejection of one's own change. */
export function mayDecide(action: TicketAction, actor: ActorRelation): boolean {
  return actor.approval === "eligible" || (action === "approve" && actor.approval === "self")
}

/** The row for `action` from the ticket's status, if the table has one. */
export function findRow(type: TicketType, status: TicketStatus, action: TicketAction): TransitionRow | undefined {
  return TRANSITION_TABLES[type].find((row) => row.action === action && row.from.includes(status))
}

export type TransitionCheck =
  | { ok: true; row: TransitionRow }
  /** Not in the table from this status — 409 `invalid-transition`. */
  | { ok: false; problem: "invalid-transition" }
  /** In the table, but not for this actor — 403. */
  | { ok: false; problem: "not-permitted" }
  /** A guard refused — 409, with the reason. */
  | { ok: false; problem: "guard"; reason: string }
  /** The required comment is missing or not public — 400 on `comment`. */
  | { ok: false; problem: "comment-required"; reason: string }
  /** A soft block — 409 `change-window-early`, retried with `confirm: true`. */
  | { ok: false; problem: "confirm-required"; reason: string }

export function checkTransition(input: {
  type: TicketType
  ticket: TransitionTicket
  action: TicketAction
  actor: ActorRelation
  comment: { visibility: "PUBLIC" | "INTERNAL" } | null
  now: Date
  /** The client's `confirm: true`, for a soft block. */
  confirm?: boolean
}): TransitionCheck {
  const row = findRow(input.type, input.ticket.status, input.action)
  if (row === undefined) return { ok: false, problem: "invalid-transition" }
  if (!permitted(row, input.actor)) return { ok: false, problem: "not-permitted" }
  const refused = row.guard?.(input.ticket, input.now) ?? null
  if (refused !== null) return { ok: false, problem: "guard", reason: refused }
  if (row.comment === "public" && input.comment?.visibility !== "PUBLIC") {
    return { ok: false, problem: "comment-required", reason: row.commentReason ?? "A public comment is required" }
  }
  const early = row.confirm?.(input.ticket, input.now) ?? null
  if (early !== null && input.confirm !== true) return { ok: false, problem: "confirm-required", reason: early }
  return { ok: true, row }
}

function permitted(row: TransitionRow, actor: ActorRelation): boolean {
  return row.who === "approver" ? mayDecide(row.action, actor) : mayPerform(row.who, actor)
}

/**
 * The actions this actor may take on this ticket now — the server's answer the
 * UI renders buttons from (ADR-0006, RBAC.md §7). Comment requirements and
 * soft blocks are not reasons to hide an action: the UI asks for the comment,
 * or for the confirmation. A guard that fails does hide it — `submit` without
 * a plan is not on offer until the plan is written.
 */
export function availableActions(input: {
  type: TicketType
  ticket: TransitionTicket
  actor: ActorRelation
  now: Date
}): TicketAction[] {
  const actions = TRANSITION_TABLES[input.type]
    .filter((row) => row.from.includes(input.ticket.status))
    .filter((row) => permitted(row, input.actor))
    .filter((row) => (row.guard?.(input.ticket, input.now) ?? null) === null)
    .map((row) => row.action)
  return [...new Set(actions)]
}
