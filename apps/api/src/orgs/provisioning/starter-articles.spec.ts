import { SLUG_PATTERN } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { DEFAULT_CATEGORIES } from "./provisioning.service"
import { STARTER_ARTICLES } from "./starter-articles"

describe("the starter knowledge base", () => {
  it("files each article under a default category, or none", () => {
    const names = new Set(DEFAULT_CATEGORIES.map((c) => c.name))
    for (const article of STARTER_ARTICLES) if (article.category !== null) expect(names, article.slug).toContain(article.category)
  })

  it("gives each a distinct, well-formed slug, and leaves room on the smallest plan", () => {
    const slugs = STARTER_ARTICLES.map((a) => a.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(slug).toMatch(SLUG_PATTERN)
    expect(STARTER_ARTICLES.length).toBeLessThan(10)
  })

  it("publishes most for everyone, and keeps the agents' own internal", () => {
    expect(STARTER_ARTICLES.filter((a) => a.visibility === "PUBLISHED").length).toBeGreaterThan(0)
    expect(STARTER_ARTICLES.filter((a) => a.visibility === "INTERNAL").map((a) => a.slug)).toEqual(["working-the-queue"])
  })
})
