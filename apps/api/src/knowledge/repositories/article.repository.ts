import { Injectable } from "@nestjs/common"
import type { ArticleVisibility } from "@patchgrid/contracts"
import type { Prisma } from "@patchgrid/database"

import { PrismaService } from "../../prisma/prisma.service"

export type ArticleRow = {
  id: string
  slug: string
  title: string
  body: string
  version: number
  visibility: ArticleVisibility
  categoryId: string | null
  authorMembershipId: string
  publishedAt: Date | null
  viewCount: number
  createdAt: Date
  updatedAt: Date
  category: { id: string; name: string } | null
  author: { id: string; displayName: string }
}

export type ArticleSummaryRow = Omit<ArticleRow, "body" | "version" | "viewCount" | "createdAt">

/**
 * What a reader may read, as a filter (DOMAIN.md §9.2): whole tiers, plus —
 * for an agent — their own drafts. Never empty for a member; the service
 * builds it from the permission matrix, never from the request.
 */
export type Readable = { visibilities: ArticleVisibility[]; draftsBy: string | null }

export type ArticleChanges = Partial<Pick<ArticleRow, "title" | "body" | "categoryId" | "visibility" | "publishedAt">>

const ROW = {
  id: true,
  slug: true,
  title: true,
  body: true,
  version: true,
  visibility: true,
  categoryId: true,
  authorMembershipId: true,
  publishedAt: true,
  viewCount: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.KnowledgeArticleSelect

const SUMMARY = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  categoryId: true,
  authorMembershipId: true,
  publishedAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.KnowledgeArticleSelect

/** `KnowledgeArticle` (DOMAIN.md §9.2). Tenant-owned; every method takes the org. */
@Injectable()
export class ArticleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The slug is the title's, made unique in this org by the first free
   * `-2`, `-3`… — read in one statement. A concurrent create taking the same
   * one is a unique violation, which the caller's retry resolves.
   */
  async freeSlug(orgId: string, base: string): Promise<string> {
    const taken = new Set(
      (
        await this.prisma.db.knowledgeArticle.findMany({
          where: { orgId, slug: { startsWith: base } },
          select: { slug: true },
        })
      ).map((r) => r.slug),
    )
    if (!taken.has(base)) return base
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${String(n)}`)) return `${base}-${String(n)}`
  }

  /** `slug-taken` when a concurrent create won the slug first. */
  async create(
    orgId: string,
    data: Pick<ArticleRow, "slug" | "title" | "body" | "categoryId" | "authorMembershipId" | "visibility" | "publishedAt">,
  ): Promise<string | "slug-taken"> {
    try {
      const row = await this.prisma.db.knowledgeArticle.create({ data: { orgId, ...data }, select: { id: true } })
      return row.id
    } catch (error) {
      if (isUniqueViolation(error)) return "slug-taken"
      throw error
    }
  }

  find(orgId: string, id: string): Promise<ArticleRow | null> {
    return this.prisma.db.knowledgeArticle.findUnique({ where: { orgId_id: { orgId, id } }, select: ROW })
  }

  findBySlug(orgId: string, slug: string): Promise<ArticleRow | null> {
    return this.prisma.db.knowledgeArticle.findUnique({ where: { orgId_slug: { orgId, slug } }, select: ROW })
  }

  /** One page, most recently updated first, keyset on (updatedAt, id). */
  list(
    orgId: string,
    readable: Readable,
    filter: { visibility?: ArticleVisibility; categoryId?: string; after: { updatedAt: Date; id: string } | null; limit: number },
  ): Promise<ArticleSummaryRow[]> {
    return this.prisma.db.knowledgeArticle.findMany({
      where: {
        orgId,
        AND: [
          readableWhere(readable),
          filter.visibility === undefined ? {} : { visibility: filter.visibility },
          filter.categoryId === undefined ? {} : { categoryId: filter.categoryId },
          filter.after === null
            ? {}
            : {
                OR: [
                  { updatedAt: { lt: filter.after.updatedAt } },
                  { updatedAt: filter.after.updatedAt, id: { lt: filter.after.id } },
                ],
              },
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: SUMMARY,
    })
  }

  /**
   * Full-text, ranked, capped (DOMAIN.md §9.1) — through the same readable
   * filter as the list, in the statement, so a draft never ranks for a
   * reader who may not open it.
   */
  async search(orgId: string, text: string, readable: Readable, limit: number): Promise<ArticleSummaryRow[]> {
    const hits = await this.prisma.tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
      FROM "KnowledgeArticle" a, websearch_to_tsquery('english', ${text}) query
      WHERE a."orgId" = ${orgId}::uuid
        AND a."searchVector" @@ query
        AND (
          a.visibility = ANY(${readable.visibilities}::"ArticleVisibility"[])
          OR (a.visibility = 'DRAFT' AND a."authorMembershipId" = ${readable.draftsBy}::uuid)
        )
      ORDER BY ts_rank(a."searchVector", query) DESC, a.id DESC
      LIMIT ${limit}
    `
    if (hits.length === 0) return []
    const rows = await this.prisma.db.knowledgeArticle.findMany({ where: { orgId, id: { in: hits.map((h) => h.id) } }, select: SUMMARY })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return hits.flatMap((h) => byId.get(h.id) ?? [])
  }

  /** `false` means someone else wrote first — 409 `stale-write`. */
  async updateVersioned(orgId: string, id: string, version: number, changes: ArticleChanges): Promise<boolean> {
    const { count } = await this.prisma.db.knowledgeArticle.updateMany({
      where: { orgId, id, version },
      data: { ...changes, version: { increment: 1 } },
    })
    return count === 1
  }

  /** A read of the article's page. Not a write the reader made, so no version and no `updatedAt`. */
  async countView(orgId: string, id: string): Promise<void> {
    await this.prisma.tx.$executeRaw`
      UPDATE "KnowledgeArticle" SET "viewCount" = "viewCount" + 1 WHERE "orgId" = ${orgId}::uuid AND id = ${id}::uuid`
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.knowledgeArticle.deleteMany({ where: { orgId, id } })
    return count === 1
  }
}

function readableWhere(readable: Readable): Prisma.KnowledgeArticleWhereInput {
  return {
    OR: [
      { visibility: { in: readable.visibilities } },
      ...(readable.draftsBy === null ? [] : [{ visibility: "DRAFT" as const, authorMembershipId: readable.draftsBy }]),
    ],
  }
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
