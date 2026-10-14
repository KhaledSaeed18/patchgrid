import { z } from "zod"

import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"

/**
 * The knowledge base (DOMAIN.md §9.2). An article is read by visibility —
 * a draft by its author and admins, an internal runbook by agents, a
 * published article by everyone in the organization and nobody outside it —
 * and edited against a `version`, because two agents fixing the same
 * runbook is ordinary.
 */

/** Storage twin: Prisma's `ArticleVisibility`. */
export const articleVisibilitySchema = z.enum(["DRAFT", "INTERNAL", "PUBLISHED"])
export type ArticleVisibility = z.infer<typeof articleVisibilitySchema>

export const ARTICLE_SLUG_MAX_LENGTH = 80

/** The knowledge pages' own addresses (`/knowledge/new`, `/knowledge/edit/…`), never an article's. */
export const RESERVED_ARTICLE_SLUGS: readonly string[] = ["new", "edit"]

/** "How do I connect to the VPN?" → "how-do-i-connect-to-the-vpn". Unique per org; the server adds `-2`, `-3`… */
export function articleSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ARTICLE_SLUG_MAX_LENGTH - 4)
    .replace(/-+$/, "")
  if (slug === "") return "article"
  return RESERVED_ARTICLE_SLUGS.includes(slug) ? `${slug}-article` : slug
}

export const articleSlugSchema = z
  .string()
  .max(ARTICLE_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: "is not an article address" })

const titleSchema = z.string().trim().min(1).max(200)
/** Markdown. Rendered without raw HTML, so it can format but never script. */
const bodySchema = z.string().trim().min(1).max(100_000)

const personSchema = z.object({ membershipId: idSchema, displayName: z.string() })

export const articleSummarySchema = z.object({
  id: idSchema,
  slug: z.string(),
  title: z.string(),
  visibility: articleVisibilitySchema,
  category: z.object({ id: idSchema, name: z.string() }).nullable(),
  author: personSchema,
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
})
export type ArticleSummary = z.infer<typeof articleSummarySchema>

/** What this actor may do to THIS article (RBAC.md §7). */
export const articleCapabilitiesSchema = z.object({
  canEdit: z.boolean(),
  /** Move it between internal and published. */
  canPublish: z.boolean(),
  /** Return it to draft — its author's, or an admin's: a draft is its author's (DOMAIN.md §9.2). */
  canDraft: z.boolean(),
  canDelete: z.boolean(),
})
export type ArticleCapabilities = z.infer<typeof articleCapabilitiesSchema>

export const articleSchema = articleSummarySchema.extend({
  body: z.string(),
  version: z.int(),
  viewCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  capabilities: articleCapabilitiesSchema,
})
export type Article = z.infer<typeof articleSchema>

export const articlePageSchema = pageSchema(articleSummarySchema)
export type ArticlePage = z.infer<typeof articlePageSchema>

/** Most recently updated first; only what the reader may read, whatever the filter says. */
export const articleListQuerySchema = paginationQuerySchema.extend({
  visibility: articleVisibilitySchema.optional(),
  categoryId: idSchema.optional(),
})
export type ArticleListQuery = z.infer<typeof articleListQuerySchema>

/** The cap on a knowledge search — ranked, so it narrows rather than pages (ADR-0012). */
export const MAX_ARTICLE_SEARCH_RESULTS = 50

/** Full-text over title and body. The portal's suggestions are this with a requester's eyes. */
export const articleSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_ARTICLE_SEARCH_RESULTS, { error: `must be at most ${MAX_ARTICLE_SEARCH_RESULTS}` })
      .default(10),
  })
  .strict()
export type ArticleSearchQuery = z.infer<typeof articleSearchQuerySchema>

export const articleSearchResultSchema = z.object({ items: z.array(articleSummarySchema) })
export type ArticleSearchResult = z.infer<typeof articleSearchResultSchema>

export const createArticleRequestSchema = z.strictObject({
  title: titleSchema,
  body: bodySchema,
  categoryId: idSchema.optional(),
  /** Anything but a draft needs `kb:publish`. */
  visibility: articleVisibilitySchema.default("DRAFT"),
})
export type CreateArticleRequest = z.input<typeof createArticleRequestSchema>

/** A stale `version` is 409 `stale-write`. The address is fixed at creation, so links keep working. */
export const updateArticleRequestSchema = z
  .strictObject({
    version: z.int().positive(),
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    categoryId: idSchema.nullable().optional(),
    visibility: articleVisibilitySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { error: "must change at least one field" })
export type UpdateArticleRequest = z.infer<typeof updateArticleRequestSchema>
