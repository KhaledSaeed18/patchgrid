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
}

export type TransitionTicket = { status: TicketStatus; closedAt: Date | null }

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

/** Problem and Change tables arrive with their milestones (M4); until then they offer nothing. */
export const TRANSITION_TABLES: Readonly<Record<TicketType, readonly TransitionRow[]>> = {
  INCIDENT: INCIDENT_TABLE,
  SERVICE_REQUEST: INCIDENT_TABLE,
  PROBLEM: [],
  CHANGE: [],
}

/** What the actor is to this ticket — loaded by the service, decided here. */
export type ActorRelation = { role: Role; isRequester: boolean; isAssignee: boolean; ticketHasAssignee: boolean }

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
  }
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

export function checkTransition(input: {
  type: TicketType
  ticket: TransitionTicket
  action: TicketAction
  actor: ActorRelation
  comment: { visibility: "PUBLIC" | "INTERNAL" } | null
  now: Date
}): TransitionCheck {
  const row = findRow(input.type, input.ticket.status, input.action)
  if (row === undefined) return { ok: false, problem: "invalid-transition" }
  if (!mayPerform(row.who, input.actor)) return { ok: false, problem: "not-permitted" }
  const refused = row.guard?.(input.ticket, input.now) ?? null
  if (refused !== null) return { ok: false, problem: "guard", reason: refused }
  if (row.comment === "public" && input.comment?.visibility !== "PUBLIC") {
    return { ok: false, problem: "comment-required", reason: row.commentReason ?? "A public comment is required" }
  }
  return { ok: true, row }
}

/**
 * The actions this actor may take on this ticket now — the server's answer the
 * UI renders buttons from (ADR-0006, RBAC.md §7). Comment requirements are not
 * a reason to hide an action: the UI asks for the comment.
 */
export function availableActions(input: {
  type: TicketType
  ticket: TransitionTicket
  actor: ActorRelation
  now: Date
}): TicketAction[] {
  const actions = TRANSITION_TABLES[input.type]
    .filter((row) => row.from.includes(input.ticket.status))
    .filter((row) => mayPerform(row.who, input.actor))
    .filter((row) => (row.guard?.(input.ticket, input.now) ?? null) === null)
    .map((row) => row.action)
  return [...new Set(actions)]
}
