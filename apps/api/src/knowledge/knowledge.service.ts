import { Injectable } from "@nestjs/common"
import {
  type Article,
  type ArticleListQuery,
  type ArticlePage,
  type ArticleSearchQuery,
  type ArticleSearchResult,
  articleSlug,
  type ArticleSummary,
  type ArticleVisibility,
  type CreateArticleRequest,
  decodeCursor,
  encodeCursor,
  type UpdateArticleRequest,
} from "@patchgrid/contracts"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { CategoriesService } from "../categories/categories.service"
import {
  ConflictProblem,
  NotFoundProblem,
  NotPermittedProblem,
  StaleWriteProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { type Clock, InjectClock } from "../common/clock/clock"
import { PrismaService } from "../prisma/prisma.service"
import { QuotaService } from "../quota/quota.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import {
  type ArticleChanges,
  ArticleRepository,
  type ArticleRow,
  type ArticleSummaryRow,
  type Readable,
} from "./repositories/article.repository"

/** A create whose slug a concurrent create took is tried again, this many times. */
const SLUG_ATTEMPTS = 3

/**
 * The knowledge base (DOMAIN.md §9.2, RBAC.md §6). Who reads an article is
 * its visibility, decided by the permission matrix — one rule for a page, a
 * list and a search, so the three cannot disagree. Editing needs `kb:write`
 * on an article the editor can read; moving it between tiers needs
 * `kb:publish`. Edits are versioned.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly articles: ArticleRepository,
    private readonly categories: CategoriesService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(query: ArticleListQuery): Promise<ArticlePage> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "kb:read_published")
    let after: { updatedAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const updatedAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || updatedAt === null || Number.isNaN(updatedAt.getTime())) {
        throw fieldError("cursor", "is not a cursor this endpoint issued")
      }
      after = { updatedAt, id: parts.id }
    }
    const rows = await this.articles.list(orgId, this.readable(actor), {
      ...(query.visibility === undefined ? {} : { visibility: query.visibility }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      after,
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toSummary),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor({ sortValue: last.updatedAt.toISOString(), id: last.id }) : null,
    }
  }

  /** Ranked and capped (DOMAIN.md §9.1). A requester's search is published articles only — the portal's suggestions. */
  async search(query: ArticleSearchQuery): Promise<ArticleSearchResult> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "kb:read_published")
    const orgId = this.tenant.requireOrgId()
    // A raw statement carries the tenant only inside a transaction, which sets it first.
    const rows = await this.prisma.transaction(() => this.articles.search(orgId, query.q, this.readable(actor), query.limit))
    return { items: rows.map(toSummary) }
  }

  /** For the editor: no view counted. */
  async get(id: string): Promise<Article> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => this.view(actor, this.readableOne(actor, await this.articles.find(orgId, id))))
  }

  /** The article's page: one read, one view counted, in one transaction. */
  async read(slug: string): Promise<Article> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      const row = this.readableOne(actor, await this.articles.findBySlug(orgId, slug))
      // A support session reads without leaving a mark (ADR-0041): no view is counted for it.
      if (actor.kind === "support") return this.view(actor, row)
      await this.articles.countView(orgId, row.id)
      return this.view(actor, { ...row, viewCount: row.viewCount + 1 })
    })
  }

  async create(request: CreateArticleRequest): Promise<Article> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    this.permissions.assert(actor, "kb:write")
    const visibility = request.visibility ?? "DRAFT"
    if (visibility !== "DRAFT") this.permissions.assert(actor, "kb:publish")
    const categoryId = request.categoryId ?? null
    if (categoryId !== null) await this.assertCategory(categoryId)
    const now = this.clock.now()

    for (let attempt = 1; ; attempt += 1) {
      const id = await this.prisma.transaction(async () => {
        const slug = await this.articles.freeSlug(orgId, articleSlug(request.title))
        const created = await this.articles.create(orgId, {
          slug,
          title: request.title,
          body: request.body,
          categoryId,
          authorMembershipId: actor.membershipId,
          visibility,
          publishedAt: visibility === "PUBLISHED" ? now : null,
        })
        if (created === "slug-taken") return null
        // After the slug is won: a lost race must not hold a unit of the plan (TENANCY.md §8).
        await this.quota.consume(orgId, "KB_ARTICLES")
        await this.audit.record(orgId, [
          {
            action: "ARTICLE_CREATED",
            entityType: "KnowledgeArticle",
            entityId: created,
            diff: { title: request.title, slug, visibility },
          },
        ])
        return created
      })
      if (id !== null) return this.get(id)
      if (attempt >= SLUG_ATTEMPTS) throw new ConflictProblem("Another article was created with this title at the same moment; try again")
    }
  }

  async update(id: string, request: UpdateArticleRequest): Promise<Article> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const row = this.readableOne(actor, await this.articles.find(orgId, id))
      this.permissions.assert(actor, "kb:write")
      const { version, ...fields } = request
      const changes: ArticleChanges = {}
      if (fields.title !== undefined && fields.title !== row.title) changes.title = fields.title
      if (fields.body !== undefined && fields.body !== row.body) changes.body = fields.body
      if (fields.categoryId !== undefined && fields.categoryId !== row.categoryId) {
        if (fields.categoryId !== null) await this.assertCategory(fields.categoryId)
        changes.categoryId = fields.categoryId
      }
      if (fields.visibility !== undefined && fields.visibility !== row.visibility) {
        this.permissions.assert(actor, "kb:publish")
        // A draft is its author's: anyone else who made one would lose sight of it, mid-save.
        if (fields.visibility === "DRAFT" && !this.mayDraft(actor, row)) {
          throw new NotPermittedProblem("Only its author or an admin can return an article to draft; make it internal instead")
        }
        changes.visibility = fields.visibility
        changes.publishedAt = fields.visibility === "PUBLISHED" ? this.clock.now() : null
      }
      if (Object.keys(changes).length === 0) {
        if (version !== row.version) throw new StaleWriteProblem()
        return
      }
      if (!(await this.articles.updateVersioned(orgId, id, version, changes))) throw new StaleWriteProblem()
      const edited = (["title", "body", "categoryId"] as const).filter((field) => field in changes)
      await this.audit.record(orgId, [
        ...(edited.length > 0
          ? [
              {
                action: "ARTICLE_UPDATED" as const,
                entityType: "KnowledgeArticle" as const,
                entityId: id,
                // Which fields, and a title's words — never two copies of a body.
                diff: {
                  fields: edited,
                  ...(changes.title === undefined ? {} : { title: { from: row.title, to: changes.title } }),
                },
              },
            ]
          : []),
        ...(changes.visibility === undefined
          ? []
          : [
              {
                action: "ARTICLE_VISIBILITY_CHANGED" as const,
                entityType: "KnowledgeArticle" as const,
                entityId: id,
                diff: { from: row.visibility, to: changes.visibility },
              },
            ]),
      ])
    })
    return this.get(id)
  }

  async remove(id: string): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      const row = this.readableOne(actor, await this.articles.find(orgId, id))
      this.permissions.assert(actor, "kb:delete", { own: row.authorMembershipId === actor.membershipId })
      if (!(await this.articles.remove(orgId, id))) throw new NotFoundProblem()
      await this.quota.release(orgId, "KB_ARTICLES")
      await this.audit.record(orgId, [
        { action: "ARTICLE_DELETED", entityType: "KnowledgeArticle", entityId: id, diff: { title: row.title, slug: row.slug } },
      ])
    })
  }

  /** The tiers this actor reads whole, and whose drafts besides (RBAC.md §6). */
  private readable(actor: TenantActor): Readable {
    const visibilities: ArticleVisibility[] = []
    if (this.permissions.can(actor, "kb:read_published")) visibilities.push("PUBLISHED")
    if (this.permissions.can(actor, "kb:read_internal")) visibilities.push("INTERNAL")
    if (this.permissions.can(actor, "kb:read_draft")) visibilities.push("DRAFT")
    const ownDrafts = !visibilities.includes("DRAFT") && this.permissions.can(actor, "kb:read_draft", { own: true })
    return { visibilities, draftsBy: ownDrafts ? actor.membershipId : null }
  }

  /** Whether the article would still be theirs to read as a draft. */
  private mayDraft(actor: TenantActor, row: Pick<ArticleRow, "authorMembershipId">): boolean {
    return this.permissions.can(actor, "kb:read_draft", { own: row.authorMembershipId === actor.membershipId })
  }

  /** Reads are 404 for an article the actor may not read (RBAC.md §11). */
  private readableOne(actor: TenantActor, row: ArticleRow | null): ArticleRow {
    if (row === null || !canRead(this.readable(actor), row)) throw new NotFoundProblem()
    return row
  }

  private view(actor: TenantActor, row: ArticleRow): Article {
    const own = row.authorMembershipId === actor.membershipId
    return {
      ...toSummary(row),
      body: row.body,
      version: row.version,
      viewCount: row.viewCount,
      createdAt: row.createdAt.toISOString(),
      capabilities: {
        canEdit: this.permissions.can(actor, "kb:write"),
        canPublish: this.permissions.can(actor, "kb:publish"),
        canDraft: this.permissions.can(actor, "kb:publish") && this.mayDraft(actor, row),
        canDelete: this.permissions.can(actor, "kb:delete", { own }),
      },
    }
  }

  private async assertCategory(categoryId: string): Promise<void> {
    if (!(await this.categories.list(false)).some((c) => c.id === categoryId)) {
      throw fieldError("categoryId", "is not an active category")
    }
  }
}

function canRead(readable: Readable, row: Pick<ArticleRow, "visibility" | "authorMembershipId">): boolean {
  return readable.visibilities.includes(row.visibility) || (row.visibility === "DRAFT" && row.authorMembershipId === readable.draftsBy)
}

function toSummary(row: ArticleSummaryRow): ArticleSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    visibility: row.visibility,
    category: row.category,
    author: { membershipId: row.author.id, displayName: row.author.displayName },
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function fieldError(path: string, message: string): ValidationProblem {
  return new ValidationProblem([{ path, message, code: "invalid_article" }])
}
