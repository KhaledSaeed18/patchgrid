import type { Role } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { AuditEntry, AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { CategoriesService } from "../categories/categories.service"
import { FixedClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, StaleWriteProblem } from "../common/problems/problem.exception"
import type { PrismaService } from "../prisma/prisma.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { KnowledgeService } from "./knowledge.service"
import type { ArticleChanges, ArticleRepository, ArticleRow, Readable } from "./repositories/article.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T09:00:00Z")

function article(over: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: "a-1",
    slug: "vpn",
    title: "VPN",
    body: "Steps",
    version: 1,
    visibility: "PUBLISHED",
    categoryId: null,
    authorMembershipId: "m-sam",
    publishedAt: new Date(0),
    viewCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    category: null,
    author: { id: "m-sam", displayName: "Sam" },
    ...over,
  }
}

/** An in-memory knowledge base behind the repository, so each rule runs through the service. */
function harness(role: Role, membershipId: string, rows: ArticleRow[] = [], options: { slugRaces?: number } = {}) {
  const store = new Map(rows.map((r) => [r.id, r]))
  const audit: AuditEntry[] = []
  const readables: Readable[] = []
  let races = options.slugRaces ?? 0
  const repo = {
    find: async (_o: string, id: string) => store.get(id) ?? null,
    findBySlug: async (_o: string, slug: string) => [...store.values()].find((r) => r.slug === slug) ?? null,
    freeSlug: async (_o: string, base: string) => ([...store.values()].some((r) => r.slug === base) ? `${base}-2` : base),
    create: async (_o: string, data: Partial<ArticleRow>) => {
      if (races > 0) {
        races -= 1
        return "slug-taken" as const
      }
      store.set("a-new", article({ ...data, id: "a-new" }))
      return "a-new"
    },
    list: async (_o: string, readable: Readable) => {
      readables.push(readable)
      return []
    },
    search: async (_o: string, _q: string, readable: Readable) => {
      readables.push(readable)
      return []
    },
    updateVersioned: async (_o: string, id: string, version: number, changes: ArticleChanges) => {
      const row = store.get(id)
      if (row === undefined || row.version !== version) return false
      store.set(id, { ...row, ...changes, version: version + 1 })
      return true
    },
    countView: async (_o: string, id: string) => {
      const row = store.get(id)
      if (row !== undefined) store.set(id, { ...row, viewCount: row.viewCount + 1 })
    },
    remove: async (_o: string, id: string) => store.delete(id),
  }
  const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId, role, teamIds: [], leadOfTeamIds: [] }
  const service = new KnowledgeService(
    repo as unknown as ArticleRepository,
    { list: async () => [{ id: "cat-1" }] } as unknown as CategoriesService,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, entries: AuditEntry[]) => void audit.push(...entries) } as unknown as AuditService,
    new FixedClock(NOW),
  )
  return { service, store, audit, readables }
}

describe("who reads what", () => {
  it("gives a requester published articles, an agent internal ones and their own drafts, an admin everything", async () => {
    const requester = harness("REQUESTER", "m-rita")
    await requester.service.search({ q: "vpn", limit: 10 })
    expect(requester.readables[0]).toEqual({ visibilities: ["PUBLISHED"], draftsBy: null })

    const agent = harness("AGENT", "m-sam")
    await agent.service.list({ limit: 25 })
    expect(agent.readables[0]).toEqual({ visibilities: ["PUBLISHED", "INTERNAL"], draftsBy: "m-sam" })

    const admin = harness("ADMIN", "m-alice")
    await admin.service.list({ limit: 25 })
    expect(admin.readables[0]).toEqual({ visibilities: ["PUBLISHED", "INTERNAL", "DRAFT"], draftsBy: null })
  })

  it("is 404 for an internal article to a requester and for another agent's draft", async () => {
    const rows = [article({ id: "a-int", visibility: "INTERNAL", publishedAt: null }), article({ id: "a-draft", visibility: "DRAFT", publishedAt: null })]
    await expect(harness("REQUESTER", "m-rita", rows).service.get("a-int")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness("AGENT", "m-tina", rows).service.get("a-draft")).rejects.toBeInstanceOf(NotFoundProblem)
    expect((await harness("AGENT", "m-sam", rows).service.get("a-draft")).capabilities).toEqual({ canEdit: true, canPublish: true, canDelete: true })
    expect((await harness("ADMIN", "m-alice", rows).service.get("a-draft")).id).toBe("a-draft")
  })

  it("counts a view on the article's page, not in the editor", async () => {
    const h = harness("REQUESTER", "m-rita", [article()])
    await h.service.get("a-1")
    expect((await h.service.read("vpn")).viewCount).toBe(1)
    expect(h.store.get("a-1")?.viewCount).toBe(1)
  })
})

describe("writing", () => {
  it("lets a requester write nothing, and gives a new article a free slug", async () => {
    await expect(harness("REQUESTER", "m-rita").service.create({ title: "Mine", body: "x" })).rejects.toBeInstanceOf(NotPermittedProblem)
    const h = harness("AGENT", "m-sam", [article()])
    const created = await h.service.create({ title: "VPN", body: "More steps", visibility: "PUBLISHED" })
    expect(created).toMatchObject({ slug: "vpn-2", visibility: "PUBLISHED", publishedAt: NOW.toISOString() })
  })

  it("tries again when a concurrent create takes the slug, and gives up after a few", async () => {
    expect((await harness("AGENT", "m-sam", [], { slugRaces: 2 }).service.create({ title: "VPN", body: "x" })).slug).toBe("vpn")
    await expect(harness("AGENT", "m-sam", [], { slugRaces: 3 }).service.create({ title: "VPN", body: "x" })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("edits against the version, and publishing sets and clears publishedAt", async () => {
    const h = harness("AGENT", "m-sam", [article({ visibility: "DRAFT", publishedAt: null })])
    await expect(h.service.update("a-1", { version: 7, title: "New" })).rejects.toBeInstanceOf(StaleWriteProblem)
    await h.service.update("a-1", { version: 1, visibility: "PUBLISHED", body: "Better steps" })
    expect(h.store.get("a-1")).toMatchObject({ visibility: "PUBLISHED", publishedAt: NOW, version: 2 })
    expect(h.audit.map((a) => [a.action, a.diff])).toEqual([
      ["ARTICLE_UPDATED", { fields: ["body"] }],
      ["ARTICLE_VISIBILITY_CHANGED", { from: "DRAFT", to: "PUBLISHED" }],
    ])
    await h.service.update("a-1", { version: 2, visibility: "INTERNAL" })
    expect(h.store.get("a-1")?.publishedAt).toBeNull()
  })

  it("lets an agent delete only their own article; an admin any", async () => {
    await expect(harness("AGENT", "m-tina", [article()]).service.remove("a-1")).rejects.toBeInstanceOf(NotPermittedProblem)
    const own = harness("AGENT", "m-sam", [article()])
    await own.service.remove("a-1")
    expect(own.store.size).toBe(0)
    await harness("ADMIN", "m-alice", [article()]).service.remove("a-1")
  })
})
