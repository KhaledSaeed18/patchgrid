"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react"
import { toast } from "sonner"

import { currentSlug, refresh, toLogin } from "@/lib/api/client"
import { API_URL } from "@/lib/config"
import {
  connect,
  type LiveEventName,
  type LiveEvents,
  type LiveFrame,
} from "@/lib/live"

import { useTenant } from "./tenant-provider"

type Subscribe = <K extends LiveEventName>(
  name: K,
  handler: (data: LiveEvents[K]) => void
) => () => void

const LiveContext = createContext<Subscribe | null>(null)

/**
 * The tab's one live connection (ADR-0008), opened once for the whole
 * workspace and shared: pages subscribe with `useLiveEvent` instead of opening
 * their own. It reacts to the two things every page cares about — a new
 * notification refreshes the inbox queries, and an assignment to this member
 * says so in a toast. Reopening refetches the inbox as well: the stream is a
 * hint, and what was missed while it was down is in the table.
 */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { org, support } = useTenant()
  // An operator in a support session has no inbox and no stream (ADR-0041): nothing to connect.
  const operator = support?.kind === "operator"
  const queryClient = useQueryClient()
  const router = useRouter()
  const listeners = useRef(new Set<(frame: LiveFrame) => void>())
  // The effect must not restart when the router's identity changes.
  const navigate = useRef(router.push)
  useEffect(() => {
    navigate.current = router.push
  }, [router])

  const subscribe = useCallback<Subscribe>((name, handler) => {
    const listener = (frame: LiveFrame) => {
      // `name` picks the payload type, which the compiler cannot follow.
      if (frame.name === name) handler(frame.data as LiveEvents[typeof name])
    }
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (operator) return
    const dispatch = (frame: LiveFrame) => {
      for (const listener of listeners.current) listener(frame)
      if (frame.name !== "notification") return
      void queryClient.invalidateQueries({ queryKey: ["notifications"] })
      if (
        frame.data.type === "TICKET_ASSIGNED" &&
        frame.data.ticketId !== null
      ) {
        const href = `/tickets/${frame.data.ticketId}`
        toast("Assigned to you", {
          description: frame.data.title,
          action: { label: "Open", onClick: () => navigate.current(href) },
        })
      }
    }
    return connect({
      url: `${API_URL}/notifications/stream`,
      // A workspace page always has one; the host is the fallback for the type.
      slug: currentSlug() ?? org.slug,
      refresh,
      onFrame: dispatch,
      onOpen: () =>
        void queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      onSessionLost: toLogin,
    })
  }, [org.slug, queryClient, operator])

  const value = useMemo(() => subscribe, [subscribe])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

/** Runs `handler` for each event of this kind while the component is mounted. */
export function useLiveEvent<K extends LiveEventName>(
  name: K,
  handler: (data: LiveEvents[K]) => void
): void {
  const subscribe = useContext(LiveContext)
  if (subscribe === null) throw new Error("useLiveEvent() outside a workspace")
  const latest = useRef(handler)
  useEffect(() => {
    latest.current = handler
  })
  useEffect(
    () => subscribe(name, (data) => latest.current(data)),
    [subscribe, name]
  )
}
