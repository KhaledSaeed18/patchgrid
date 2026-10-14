import {
  type NotificationEvent,
  notificationEventSchema,
  type TicketUpdatedEvent,
  ticketUpdatedEventSchema,
} from "@patchgrid/contracts"

/**
 * The live stream's moving parts, apart from React (ADR-0008). The stream is
 * a hint and the table is the truth: nothing here carries state a page needs,
 * it only says "look again". So a frame that does not parse is dropped, and a
 * dropped connection costs one refetch when the next one opens.
 */

/** Every event the stream sends, by its SSE `event:` name. */
export type LiveEvents = {
  notification: NotificationEvent
  "ticket-updated": TicketUpdatedEvent
}
export type LiveEventName = keyof LiveEvents

export const LIVE_EVENT_NAMES: readonly LiveEventName[] = [
  "notification",
  "ticket-updated",
]

export type LiveFrame = {
  [K in LiveEventName]: { name: K; data: LiveEvents[K] }
}[LiveEventName]

/** A frame's JSON against its contract, or `null` for anything else. */
export function parseFrame(name: string, raw: unknown): LiveFrame | null {
  if (typeof raw !== "string") return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  if (name === "notification") {
    const parsed = notificationEventSchema.safeParse(json)
    return parsed.success ? { name, data: parsed.data } : null
  }
  if (name === "ticket-updated") {
    const parsed = ticketUpdatedEventSchema.safeParse(json)
    return parsed.success ? { name, data: parsed.data } : null
  }
  return null
}

/** `EventSource.CLOSED`, which jsdom does not define. */
const CLOSED = 2

/**
 * The server ends the stream when the access token expires. The browser
 * reconnects by itself after a normal end, but a reconnect answered with a 401
 * leaves it `CLOSED` for good — and that, only that, is when to refresh.
 * `CONNECTING` is the browser retrying a blip on its own.
 */
export function shouldRefreshOnError(readyState: number): boolean {
  return readyState === CLOSED
}

const BACKOFF_FIRST_MS = 1_000
const BACKOFF_MAX_MS = 30_000

/** 1s, 2s, 4s … capped at 30s, for the nth manual reopen in a row. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt))
}

/** The part of `EventSource` the connection uses, so a test can stand one in. */
export type SourceLike = {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export type Connection = {
  url: string
  slug: string
  /** Rotates the session; `false` means it cannot be rotated. */
  refresh: (slug: string) => Promise<boolean>
  onFrame: (frame: LiveFrame) => void
  /** Every (re)open: the moment to refetch whatever was missed meanwhile. */
  onOpen: () => void
  /** The session is gone; nothing left to try. */
  onSessionLost: () => void
  open?: (url: string) => SourceLike
}

const defaultOpen = (url: string): SourceLike =>
  new EventSource(url, { withCredentials: true })

/**
 * Keeps one stream open until stopped. A normal end is the browser's to
 * handle; a terminal one refreshes the session and reopens after a capped
 * backoff, and a refresh that fails ends the session. Returns the stop
 * function.
 */
export function connect(connection: Connection): () => void {
  const open = connection.open ?? defaultOpen
  let source: SourceLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let attempt = 0

  const recover = async () => {
    const refreshed = await connection.refresh(connection.slug)
    if (stopped) return
    if (!refreshed) {
      connection.onSessionLost()
      return
    }
    timer = setTimeout(start, backoffDelay(attempt))
    attempt += 1
  }

  function start() {
    timer = null
    const current = open(connection.url)
    source = current
    current.addEventListener("open", () => {
      attempt = 0
      connection.onOpen()
    })
    for (const name of LIVE_EVENT_NAMES) {
      current.addEventListener(name, (event) => {
        const frame = parseFrame(name, (event as MessageEvent).data)
        if (frame !== null) connection.onFrame(frame)
      })
    }
    current.addEventListener("error", () => {
      if (!shouldRefreshOnError(current.readyState)) return
      current.close()
      void recover()
    })
  }

  start()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    source?.close()
  }
}

/**
 * Whether someone is mid-edit on the page: a dialog is open, a select has
 * focus, or the focused text field holds something. A live refresh waits for
 * them rather than remount a form from under their hands.
 */
export function isEditing(doc: Document): boolean {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"]') !== null)
    return true
  const active = doc.activeElement
  if (active instanceof HTMLSelectElement) return true
  return (
    (active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement) &&
    active.value !== ""
  )
}
