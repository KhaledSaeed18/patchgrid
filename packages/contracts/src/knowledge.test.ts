import { describe, expect, it } from "vitest"

import { articleSlug, articleSlugSchema, createArticleRequestSchema, updateArticleRequestSchema } from "./knowledge.ts"

describe("an article's address", () => {
  it("is the title in lower-case words, never empty, and always a valid slug", () => {
    expect(articleSlug("How do I connect to the VPN?")).toBe("how-do-i-connect-to-the-vpn")
    expect(articleSlug("Café Wi‑Fi — guest access")).toBe("cafe-wi-fi-guest-access")
    expect(articleSlug("???")).toBe("article")
    const long = articleSlug("word ".repeat(40))
    expect(long.length).toBeLessThanOrEqual(76)
    expect(articleSlugSchema.safeParse(`${long}-12`).success).toBe(true)
  })
})

describe("an article request", () => {
  it("starts as a draft and refuses an empty body or an unknown field", () => {
    expect(createArticleRequestSchema.parse({ title: "VPN", body: "Steps" }).visibility).toBe("DRAFT")
    expect(createArticleRequestSchema.safeParse({ title: "VPN", body: "  " }).success).toBe(false)
    expect(createArticleRequestSchema.safeParse({ title: "VPN", body: "x", slug: "mine" }).success).toBe(false)
  })

  it("edits against a version and must change something", () => {
    expect(updateArticleRequestSchema.safeParse({ version: 1 }).success).toBe(false)
    expect(updateArticleRequestSchema.safeParse({ title: "New" }).success).toBe(false)
    expect(updateArticleRequestSchema.safeParse({ version: 1, visibility: "PUBLISHED" }).success).toBe(true)
  })
})
