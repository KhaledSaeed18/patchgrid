import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  backoffDelay,
  connect,
  isEditing,
  type LiveFrame,
  parseFrame,
  shouldRefreshOnError,
  type SourceLike,
} from "./live"

const ID = "01a12143-4880-7565-af57-28f3376d6bd7"
const UPDATED = { ticketId: ID, updatedAt: "2026-01-01T00:00:00.000Z" }

class FakeSource implements SourceLike {
  readyState = 0
  closed = false
  private listeners = new Map<string, ((event: Event) => void)[]>()
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, init: { data?: string } = {}) {
    const event = Object.assign(new Event(type), init)
    for (const l of this.listeners.get(type) ?? []) l(event)
  }
}

describe("parseFrame", () => {
  it("accepts a frame that satisfies its contract", () => {
    const data = { id: ID, type: "TICKET_ASSIGNED", title: "T", ticketId: ID }
    expect(parseFrame("notification", JSON.stringify(data))).toEqual({
      name: "notification",
      data,
    })
    expect(parseFrame("ticket-updated", JSON.stringify(UPDATED))).toEqual({
      name: "ticket-updated",
      data: UPDATED,
    })
  })

  it("drops anything else", () => {
    expect(parseFrame("notification", "not json")).toBeNull()
    expect(parseFrame("notification", "{}")).toBeNull()
    expect(parseFrame("ticket-updated", undefined)).toBeNull()
    expect(parseFrame("mystery", "{}")).toBeNull()
  })
})

describe("reconnect policy", () => {
  it("refreshes only when the browser has given up", () => {
    expect(shouldRefreshOnError(0)).toBe(false)
    expect(shouldRefreshOnError(1)).toBe(false)
    expect(shouldRefreshOnError(2)).toBe(true)
  })

  it("backs off from one second to a thirty second cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })
})

describe("connect", () => {
  let sources: FakeSource[]
  let refresh: ReturnType<typeof vi.fn<(slug: string) => Promise<boolean>>>
  let onOpen: ReturnType<typeof vi.fn<() => void>>
  let onSessionLost: ReturnType<typeof vi.fn<() => void>>
  let frames: LiveFrame[]

  const start = () =>
    connect({
      url: "http://api.lvh.me:4000/api/v1/notifications/stream",
      slug: "acme",
      refresh,
      onFrame: (f) => frames.push(f),
      onOpen,
      onSessionLost,
      open: () => {
        const source = new FakeSource()
        sources.push(source)
        return source
      },
    })
  /** The newest stream, which the browser has given up on. */
  const die = () => {
    const source = sources.at(-1)
    if (source === undefined) throw new Error("no stream")
    source.readyState = 2
    source.emit("error")
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sources = []
    frames = []
    refresh = vi.fn(async () => true)
    onOpen = vi.fn()
    onSessionLost = vi.fn()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("delivers parsed frames and reports every open", () => {
    start()
    sources[0]?.emit("open")
    sources[0]?.emit("ticket-updated", { data: JSON.stringify(UPDATED) })
    sources[0]?.emit("ticket-updated", { data: "garbage" })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(frames).toEqual([{ name: "ticket-updated", data: UPDATED }])
  })

  it("leaves a blip to the browser", async () => {
    start()
    sources[0]?.emit("error")
    await vi.runAllTimersAsync()
    expect(refresh).not.toHaveBeenCalled()
    expect(sources).toHaveLength(1)
  })

  it("refreshes a closed stream and reopens it after the backoff", async () => {
    start()
    die()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledWith("acme")
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(2)
  })

  it("backs off while reopens keep failing, and resets once one opens", async () => {
    start()
    die()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sources).toHaveLength(2)
    die()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(3)
    sources[2]?.emit("open")
    die()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sources).toHaveLength(4)
  })

  it("gives up on the session when the refresh fails", async () => {
    refresh.mockResolvedValue(false)
    start()
    die()
    await vi.runAllTimersAsync()
    expect(onSessionLost).toHaveBeenCalledTimes(1)
    expect(sources).toHaveLength(1)
  })

  it("stops for good: closes the stream and cancels a pending reopen", async () => {
    const stop = start()
    die()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.runAllTimersAsync()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.closed).toBe(true)
  })
})

describe("isEditing", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("is false on a quiet page and for an empty focused field", () => {
    document.body.innerHTML = "<textarea></textarea>"
    document.querySelector("textarea")?.focus()
    expect(isEditing(document)).toBe(false)
  })

  it("is true for a filled field, a focused select or an open dialog", () => {
    document.body.innerHTML = "<textarea>draft</textarea>"
    document.querySelector("textarea")?.focus()
    expect(isEditing(document)).toBe(true)

    document.body.innerHTML = "<select><option>a</option></select>"
    document.querySelector("select")?.focus()
    expect(isEditing(document)).toBe(true)

    document.body.innerHTML = '<div role="dialog"></div>'
    expect(isEditing(document)).toBe(true)
  })
})
