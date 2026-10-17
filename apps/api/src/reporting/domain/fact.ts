import type { Priority, TicketType } from "@patchgrid/contracts"

/** What a fact is built from: the ticket as it is (ADR-0051). */
export type FactSource = {
  id: string
  version: number
  type: TicketType
  priority: Priority
  teamId: string | null
  categoryId: string | null
  assigneeMembershipId: string | null
  createdAt: Date
  responseClockStartedAt: Date
  resolutionClockStartedAt: Date
  respondBy: Date | null
  resolveBy: Date | null
  respondedAt: Date | null
  resolvedAt: Date | null
  closedAt: Date | null
  cancelledAt: Date | null
  pausedMinutes: number
  responseBreached: boolean
  resolutionBreached: boolean
  reopenCount: number
  /** When the ticket last changed: the reconcile's grace before calling a difference drift. */
  updatedAt: Date
}

export type FactState = "OPEN" | "RESOLVED" | "CLOSED" | "CANCELLED"
export type ClockOutcome = "NONE" | "RUNNING" | "MET" | "BREACHED"

export type Fact = {
  ticketId: string
  sourceVersion: number
  type: TicketType
  priority: Priority
  teamId: string | null
  categoryId: string | null
  assigneeMembershipId: string | null
  state: FactState
  createdAt: Date
  resolvedAt: Date | null
  closedAt: Date | null
  responseMinutes: number | null
  resolutionMinutes: number | null
  response: ClockOutcome
  resolution: ClockOutcome
  reopenCount: number
}

const MINUTE = 60_000
const minutesBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / MINUTE)

/**
 * A clock's outcome. Stopped: breached if the scan flagged it or it stopped
 * after its deadline. Running: breached only once the scan has flagged it,
 * which is a write and so an event; never by comparing with "now", so the same
 * ticket always builds the same fact (ADR-0051).
 */
function outcome(due: Date | null, stoppedAt: Date | null, flagged: boolean): ClockOutcome {
  if (due === null) return "NONE"
  if (stoppedAt === null) return flagged ? "BREACHED" : "RUNNING"
  return flagged || stoppedAt.getTime() > due.getTime() ? "BREACHED" : "MET"
}

/**
 * The one place a ticket becomes a fact, used by the consumer and the
 * reconcile alike. Durations are whole minutes, rounded down; the resolution
 * time is less the paused minutes, as the clock itself counts (ADR-0003).
 */
export function factOf(ticket: FactSource): Fact {
  const state: FactState =
    ticket.cancelledAt !== null ? "CANCELLED" : ticket.closedAt !== null ? "CLOSED" : ticket.resolvedAt !== null ? "RESOLVED" : "OPEN"
  return {
    ticketId: ticket.id,
    sourceVersion: ticket.version,
    type: ticket.type,
    priority: ticket.priority,
    teamId: ticket.teamId,
    categoryId: ticket.categoryId,
    assigneeMembershipId: ticket.assigneeMembershipId,
    state,
    createdAt: ticket.createdAt,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    responseMinutes: ticket.respondedAt === null ? null : Math.max(0, minutesBetween(ticket.responseClockStartedAt, ticket.respondedAt)),
    resolutionMinutes:
      ticket.resolvedAt === null
        ? null
        : Math.max(0, minutesBetween(ticket.resolutionClockStartedAt, ticket.resolvedAt) - ticket.pausedMinutes),
    response: outcome(ticket.respondBy, ticket.respondedAt, ticket.responseBreached),
    resolution: outcome(ticket.resolveBy, ticket.resolvedAt, ticket.resolutionBreached),
    reopenCount: ticket.reopenCount,
  }
}

/** Whether two facts say the same thing: what the reconcile calls drift when they do not. */
export function sameFact(a: Fact, b: Fact): boolean {
  const time = (d: Date | null) => d?.getTime() ?? null
  return (
    a.sourceVersion === b.sourceVersion &&
    a.type === b.type &&
    a.priority === b.priority &&
    a.teamId === b.teamId &&
    a.categoryId === b.categoryId &&
    a.assigneeMembershipId === b.assigneeMembershipId &&
    a.state === b.state &&
    time(a.createdAt) === time(b.createdAt) &&
    time(a.resolvedAt) === time(b.resolvedAt) &&
    time(a.closedAt) === time(b.closedAt) &&
    a.responseMinutes === b.responseMinutes &&
    a.resolutionMinutes === b.resolutionMinutes &&
    a.response === b.response &&
    a.resolution === b.resolution &&
    a.reopenCount === b.reopenCount
  )
}
