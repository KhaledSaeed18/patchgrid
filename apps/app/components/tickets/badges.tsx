import type { Priority, TicketStatus } from "@patchgrid/contracts"
import { cn } from "@patchgrid/ui/lib/utils"

import { PRIORITY_LABEL, TICKET_STATUS_LABEL } from "@/lib/labels"

/** The same scale the marketing site's priority matrix uses: one hue, rising weight. */
const PRIORITY_TONE: Record<Priority, string> = {
  LOW: "bg-foreground/[0.06] text-foreground",
  MEDIUM: "bg-primary/20 text-foreground",
  HIGH: "bg-primary/55 text-foreground",
  CRITICAL: "bg-primary text-primary-foreground",
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        PRIORITY_TONE[priority]
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  )
}

/** Finished tickets read quieter than live ones; a ticket waiting on someone reads as such. */
const STATUS_TONE: Partial<Record<TicketStatus, string>> = {
  NEW: "border-foreground/30",
  PENDING: "border-dashed border-foreground/40",
  RESOLVED: "border-transparent bg-foreground/[0.06]",
  CLOSED: "border-transparent text-muted-foreground",
  CANCELLED: "border-transparent text-muted-foreground line-through",
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm border border-border px-1.5 text-xs whitespace-nowrap",
        STATUS_TONE[status]
      )}
    >
      {TICKET_STATUS_LABEL[status]}
    </span>
  )
}
