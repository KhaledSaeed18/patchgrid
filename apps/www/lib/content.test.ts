import { readdirSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { DOC_SECTIONS, DOCS, POSTS, formatDate, neighbours } from "./content"

const files = (dir: string) =>
  readdirSync(path.join(import.meta.dirname, "../content", dir))
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => f.replace(/\.mdx$/, ""))
    .sort()

describe("content registry", () => {
  it("has a file for every doc, and an entry for every doc file", () => {
    expect(DOCS.map((d) => d.slug).sort()).toEqual(files("docs"))
  })

  it("has a file for every post, and an entry for every post file", () => {
    expect(POSTS.map((p) => p.slug).sort()).toEqual(files("blog"))
  })

  it("never repeats a slug", () => {
    for (const list of [DOCS, POSTS]) {
      expect(new Set(list.map((e) => e.slug)).size).toBe(list.length)
    }
  })

  it("keeps descriptions short enough for a search result", () => {
    for (const entry of [...DOCS, ...POSTS]) expect(entry.description.length).toBeLessThanOrEqual(155)
  })

  it("lists docs section by section, so the sidebar and previous/next agree", () => {
    const order = DOCS.map((d) => DOC_SECTIONS.indexOf(d.section))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it("lists posts newest first, with real dates", () => {
    const dates = POSTS.map((p) => p.date)
    for (const date of dates) expect(Number.isNaN(Date.parse(date))).toBe(false)
    expect(dates).toEqual([...dates].sort().reverse())
  })
})

describe("neighbours", () => {
  it("has no previous for the first doc and no next for the last", () => {
    expect(neighbours(DOCS[0]?.slug ?? "").previous).toBeUndefined()
    expect(neighbours(DOCS.at(-1)?.slug ?? "").next).toBeUndefined()
  })

  it("knows nothing of a slug that is not a doc", () => {
    expect(neighbours("nope")).toEqual({})
  })
})

describe("formatDate", () => {
  it("writes the day out, in UTC whatever the machine's zone", () => {
    expect(formatDate("2026-10-02")).toBe("2 October 2026")
  })
})
