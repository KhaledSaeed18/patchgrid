import type { MetadataRoute } from "next"

import { SITE_URL } from "@/lib/config"
import { DOCS, POSTS } from "@/lib/content"
import { PROBLEM_TYPES } from "@/lib/problems"

/**
 * Every public page, from the same registries the pages render from — a doc or
 * a post cannot exist without being listed here. Nothing a workspace holds is
 * on this host, so nothing tenant-shaped can appear (ADR-0014).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const page = (
    path: string,
    extra: Partial<MetadataRoute.Sitemap[number]> = {}
  ) => ({
    url: new URL(path, SITE_URL).toString(),
    ...extra,
  })
  return [
    page("/", { priority: 1 }),
    page("/pricing", { priority: 0.8 }),
    page("/signup", { priority: 0.8 }),
    page("/docs", { priority: 0.7 }),
    ...DOCS.map((doc) => page(`/docs/${doc.slug}`, { priority: 0.6 })),
    page("/blog", { priority: 0.6 }),
    ...POSTS.map((post) =>
      page(`/blog/${post.slug}`, { lastModified: post.date, priority: 0.5 })
    ),
    page("/problems", { priority: 0.3 }),
    ...PROBLEM_TYPES.map((problem) =>
      page(`/problems/${problem.slug}`, { priority: 0.2 })
    ),
  ]
}
