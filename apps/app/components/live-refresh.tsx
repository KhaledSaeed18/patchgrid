"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

import { isEditing } from "@/lib/live"

import { useLiveEvent } from "./live-provider"

/** How long to wait before trying again while the member is mid-edit. */
const HOLD_RETRY_MS = 2_000

/**
 * Re-renders the server component it sits in when a ticket changes, so a page
 * that was read once stays true without a reload. With a `ticketId` only that
 * ticket's events count (the ticket page); without one any event does (the
 * lists). Bursts collapse into one refresh after `delay`. `router.refresh()`
 * keeps client state, but a form keyed to the ticket's version remounts, so
 * `holdWhileEditing` postpones the refresh until the member has stopped
 * typing in or choosing from something.
 */
export function LiveRefresh({
  ticketId,
  delay,
  holdWhileEditing = false,
}: {
  ticketId?: string
  delay: number
  holdWhileEditing?: boolean
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const latest = useRef<() => void>(() => undefined)
  const schedule = useCallback((wait: number) => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      latest.current()
    }, wait)
  }, [])
  const refreshNow = () => {
    if (holdWhileEditing && isEditing(document)) {
      schedule(HOLD_RETRY_MS)
      return
    }
    // The lists keep their pages in the query cache, which `refresh()` alone leaves as it was.
    void queryClient.invalidateQueries({ queryKey: ["tickets"] })
    router.refresh()
  }
  useEffect(() => {
    latest.current = refreshNow
  })
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  useLiveEvent("ticket-updated", (event) => {
    if (ticketId === undefined || event.ticketId === ticketId) schedule(delay)
  })
  // Sweeps (an SLA flag, an auto-close) tell the people concerned but send
  // no ticket-updated; the ticket page showing that ticket refreshes anyway.
  useLiveEvent("notification", (event) => {
    if (ticketId !== undefined && event.ticketId === ticketId) schedule(delay)
  })
  return null
}
