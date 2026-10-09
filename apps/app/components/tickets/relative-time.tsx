"use client"

import { useEffect, useState } from "react"

import { relativeTime } from "@/lib/relative-time"

/**
 * A timestamp as "3 hours ago", with the exact time on hover. Rendered on the
 * server too, so the text may differ by a minute at hydration — expected, and
 * corrected by the next tick.
 */
export function RelativeTime({
  at,
  className,
}: {
  at: string
  className?: string
}) {
  const now = useNow()
  const date = new Date(at)
  return (
    <time
      dateTime={at}
      title={date.toLocaleString()}
      className={className}
      suppressHydrationWarning
    >
      {relativeTime(date, now)}
    </time>
  )
}

/** The current time, refreshed every half minute — enough for minute-grained text. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
