import { describe, expect, it } from "vitest"

import { encodeFrame } from "./sse"

describe("encodeFrame", () => {
  it("writes an event with its id and JSON data, then a blank line", () => {
    expect(encodeFrame({ event: "notification", id: "n-1", data: { a: 1 } })).toBe('event: notification\nid: n-1\ndata: {"a":1}\n\n')
    expect(encodeFrame({ event: "ticket-updated", data: { t: "x\ny" } })).toBe('event: ticket-updated\ndata: {"t":"x\\ny"}\n\n')
  })

  it("keeps a comment on one line", () => {
    expect(encodeFrame({ comment: "heart\nbeat" })).toBe(": heart beat\n\n")
  })
})
