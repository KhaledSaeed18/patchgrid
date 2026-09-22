import { describe, expect, it } from "vitest"

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
  parseSort,
} from "./pagination.ts"

describe("cursors", () => {
  it("round-trips", () => {
    const parts = { sortValue: "2026-09-22T10:00:00.000Z", id: "0195f0a0-1b2c-7d3e-8f01-234567890abc" }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })

  it("survives values containing separators", () => {
    const parts = { sortValue: 'a,b:c"d', id: "x" }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })

  it.each([
    ["", "empty"],
    ["not-base64!!", "not base64"],
    [Buffer.from('"a string"').toString("base64url"), "valid base64, wrong shape"],
    [Buffer.from("[1,2]").toString("base64url"), "valid shape, wrong types"],
    [Buffer.from('["a"]').toString("base64url"), "wrong arity"],
  ])("returns null for a malformed cursor (%s)", (cursor) => {
    // A malformed cursor is a 400, never a crash — the value is client-supplied.
    expect(decodeCursor(cursor)).toBeNull()
  })
})

describe("paginationQuerySchema", () => {
  it("defaults the limit", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE })
  })

  it("coerces the limit from a query string", () => {
    expect(paginationQuerySchema.parse({ limit: "10" }).limit).toBe(10)
  })

  it("caps the limit so one request cannot ask for the whole table", () => {
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false)
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
  })
})

describe("parseSort", () => {
  it("reads a leading hyphen as descending", () => {
    expect(parseSort("-createdAt")).toEqual({ field: "createdAt", direction: "desc" })
    expect(parseSort("createdAt")).toEqual({ field: "createdAt", direction: "asc" })
  })
})
