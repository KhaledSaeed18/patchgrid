import { describe, expect, it } from "vitest"

import { DOCS, POSTS } from "./content"
import { blogPosting, serialise, techArticle } from "./structured-data"

describe("serialise", () => {
  it("cannot close the script element it is written into", () => {
    const out = serialise({ name: "</script><script>alert(1)</script>" })
    expect(out).not.toContain("</script>")
    expect(JSON.parse(out)).toEqual({ name: "</script><script>alert(1)</script>" })
  })
})

describe("structured data", () => {
  it("gives every doc an article and a two-step breadcrumb", () => {
    for (const doc of DOCS) {
      const [article, crumbs] = techArticle(doc)
      expect(article).toMatchObject({ "@type": "TechArticle", headline: doc.title })
      expect(crumbs).toMatchObject({ "@type": "BreadcrumbList" })
    }
  })

  it("dates every post", () => {
    for (const post of POSTS) {
      const [posting] = blogPosting(post)
      expect(posting).toMatchObject({ "@type": "BlogPosting", datePublished: post.date })
    }
  })
})
