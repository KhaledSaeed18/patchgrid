"use client"

import { cn } from "@patchgrid/ui/lib/utils"

import { relativeTime } from "@/lib/relative-time"

import { useNow } from "./relative-time"

/**
 * The deadline that matters now (response until answered, then resolution),
 * as a countdown. `breached` is sticky — any target missed, ever — so a
 * ticket answered late can still be counting down to its resolution: that
 * reads as the countdown with a mark, not as "breached in 3 hours".
 */
export function DueBadge({
  dueAt,
  breached,
  paused,
}: {
  dueAt: string | null
  breached: boolean
  /** `PENDING`: the resolution clock is stopped while the requester answers (DOMAIN.md §4.2). */
  paused: boolean
}) {
  const now = useNow()
  if (paused) {
    return (
      <span className="text-sm text-muted-foreground">
        Paused{breached ? ", a target was missed" : ""}
      </span>
    )
  }
  if (dueAt === null) {
    return breached ? (
      <Missed>Missed a target</Missed>
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }
  const due = new Date(dueAt)
  const left = due.getTime() - now.getTime()
  if (left < 0) {
    return (
      <Missed title={due.toLocaleString()}>
        Overdue, due {relativeTime(due, now)}
      </Missed>
    )
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap tabular-nums",
        left < 60 * 60_000
          ? "font-medium text-foreground"
          : "text-muted-foreground"
      )}
      title={
        breached
          ? `${due.toLocaleString()} — an earlier target was missed`
          : due.toLocaleString()
      }
      suppressHydrationWarning
    >
      {breached && (
        <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
      )}
      {relativeTime(due, now)}
      {breached && (
        <span className="sr-only">, an earlier target was missed</span>
      )}
    </span>
  )
}

function Missed({
  children,
  title,
}: {
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      className="inline-flex h-5 items-center rounded-sm bg-destructive/10 px-1.5 text-xs font-medium whitespace-nowrap text-destructive"
      title={title}
      suppressHydrationWarning
    >
      {children}
    </span>
  )
}
