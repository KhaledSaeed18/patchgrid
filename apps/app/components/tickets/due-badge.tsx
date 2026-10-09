"use client"

import { cn } from "@patchgrid/ui/lib/utils"

import { relativeTime } from "@/lib/relative-time"

import { useNow } from "./relative-time"

/**
 * The deadline that matters now (response until answered, then resolution),
 * as a countdown. A missed one says so in words and colour; one under an
 * hour away is emphasised. `null` means no clock — nothing to show.
 */
export function DueBadge({
  dueAt,
  breached,
}: {
  dueAt: string | null
  breached: boolean
}) {
  const now = useNow()
  if (dueAt === null) return <span className="text-muted-foreground">—</span>
  const due = new Date(dueAt)
  const left = due.getTime() - now.getTime()
  if (breached || left < 0) {
    return (
      <span
        className="inline-flex h-5 items-center rounded-sm bg-destructive/10 px-1.5 text-xs font-medium whitespace-nowrap text-destructive"
        title={due.toLocaleString()}
        suppressHydrationWarning
      >
        Breached {relativeTime(due, now)}
      </span>
    )
  }
  return (
    <span
      className={cn(
        "text-sm whitespace-nowrap tabular-nums",
        left < 60 * 60_000
          ? "font-medium text-foreground"
          : "text-muted-foreground"
      )}
      title={due.toLocaleString()}
      suppressHydrationWarning
    >
      {relativeTime(due, now)}
    </span>
  )
}
