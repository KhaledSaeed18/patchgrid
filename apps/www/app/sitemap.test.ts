import { describe, expect, it } from "vitest"

import { DOCS, POSTS } from "@/lib/content"
import { PROBLEM_TYPES } from "@/lib/problems"

import robots from "./robots"
import sitemap from "./sitemap"

describe("sitemap", () => {
  const urls = sitemap().map((entry) => new URL(entry.url).pathname)

  it("lists every doc, post and problem type", () => {
    for (const doc of DOCS) expect(urls).toContain(`/docs/${doc.slug}`)
    for (const post of POSTS) expect(urls).toContain(`/blog/${post.slug}`)
    for (const problem of PROBLEM_TYPES) expect(urls).toContain(`/problems/${problem.slug}`)
  })

  it("lists each address once", () => {
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe("robots", () => {
  it("points crawlers at the sitemap on this site", () => {
    expect(String(robots().sitemap)).toMatch(/\/sitemap\.xml$/)
  })
})
