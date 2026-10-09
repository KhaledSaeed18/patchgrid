import type { TicketSummary } from "@patchgrid/contracts"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import Link from "next/link"

import { PriorityBadge, StatusBadge } from "./badges"
import { DueBadge } from "./due-badge"
import { RelativeTime } from "./relative-time"

/**
 * Tickets as rows. `columns` picks what the audience needs: a requester knows
 * who raised them, an agent needs the requester and the deadline.
 */
export function TicketTable({
  tickets,
  columns,
}: {
  tickets: TicketSummary[]
  columns: "portal" | "console"
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Ticket</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Priority</TableHead>
          {columns === "console" ? (
            <>
              <TableHead>Requester</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Due</TableHead>
            </>
          ) : (
            <TableHead>Handled by</TableHead>
          )}
          {columns === "portal" && (
            <TableHead className="text-right">Updated</TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {tickets.map((ticket) => (
          <TableRow key={ticket.id}>
            <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
              {ticket.number}
            </TableCell>
            <TableCell className="max-w-xs">
              <Link
                href={`/tickets/${ticket.id}`}
                className="block truncate font-medium hover:underline"
              >
                {ticket.title}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge status={ticket.status} />
            </TableCell>
            <TableCell>
              <PriorityBadge priority={ticket.priority} />
            </TableCell>
            {columns === "console" ? (
              <>
                <TableCell className="text-muted-foreground">
                  {ticket.requester.displayName}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ticket.assignee?.displayName ?? ticket.team?.name ?? "—"}
                </TableCell>
                <TableCell>
                  <DueBadge
                    dueAt={ticket.dueAt}
                    breached={ticket.breached}
                    paused={ticket.status === "PENDING"}
                  />
                </TableCell>
              </>
            ) : (
              <TableCell className="text-muted-foreground">
                {ticket.assignee?.displayName ??
                  ticket.team?.name ??
                  "Not picked up yet"}
              </TableCell>
            )}
            {columns === "portal" && (
              <TableCell className="text-right text-muted-foreground">
                <RelativeTime at={ticket.updatedAt} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
