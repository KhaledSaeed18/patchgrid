import {
  formatTicketNumber,
  type Ticket,
  type TicketAction,
  type TicketCapabilities,
  type TicketSummary,
} from "@patchgrid/contracts"

import { clockView } from "./domain/sla"
import type { TicketRow, TicketSummaryRow } from "./repositories/ticket.repository"

const iso = (d: Date | null) => d?.toISOString() ?? null
const person = (p: { id: string; displayName: string } | null) =>
  p === null ? null : { membershipId: p.id, displayName: p.displayName }

/** The deadline that matters now: response until answered, then resolution; none once resolved. */
function due(row: Pick<TicketSummaryRow, "respondBy" | "resolveBy" | "respondedAt" | "resolvedAt">): Date | null {
  if (row.resolvedAt !== null) return null
  return row.respondedAt === null ? row.respondBy : row.resolveBy
}

export function toSummary(row: TicketSummaryRow, now: Date): TicketSummary {
  const dueAt = due(row)
  return {
    id: row.id,
    number: formatTicketNumber(row.type, row.number),
    type: row.type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    requester: { membershipId: row.requester.id, displayName: row.requester.displayName },
    assignee: person(row.assignee),
    team: row.team,
    dueAt: iso(dueAt),
    breached:
      row.responseBreached ||
      row.resolutionBreached ||
      (dueAt !== null && row.pausedAt === null && dueAt.getTime() < now.getTime()),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function toTicket(
  row: TicketRow,
  now: Date,
  availableActions: TicketAction[],
  capabilities: TicketCapabilities,
): Ticket {
  const clocks = clockView(row, now)
  const clock = (c: typeof clocks.response) => ({
    due: iso(c.due),
    stoppedAt: iso(c.stoppedAt),
    breached: c.breached,
    paused: c.paused,
  })
  return {
    ...toSummary(row, now),
    description: row.description,
    version: row.version,
    impact: row.impact,
    urgency: row.urgency,
    category: row.category,
    source: row.source,
    reopenCount: row.reopenCount,
    sla: row.slaPolicyId === null ? null : { response: clock(clocks.response), resolution: clock(clocks.resolution) },
    resolvedAt: iso(row.resolvedAt),
    closedAt: iso(row.closedAt),
    availableActions,
    capabilities,
  }
}
