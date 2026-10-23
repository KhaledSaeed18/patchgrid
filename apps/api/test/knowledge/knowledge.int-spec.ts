/**
 * The knowledge base end to end (DOMAIN.md §9.2): articles written and
 * published by agents, read by visibility, found by full-text search with
 * English stemming — and a draft or an internal runbook never ranking for a
 * reader who may not open it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "requester" | "agent" | "other" | "admin"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
const ids: Record<string, string> = {}

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "kb", people: { requester: "REQUESTER", agent: "AGENT", other: "AGENT", admin: "ADMIN" } })
})

afterAll(async () => {
  await db.knowledgeArticle.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const titles = (body: { items: { title: string }[] }) => body.items.map((a) => a.title).toSorted()

describe("writing", () => {
  it("creates in three tiers, each with an address made from its title", async () => {
    const published = await as("agent").post("/articles", {
      title: "Connecting to the VPN",
      body: "Open the client, sign in, and pick the nearest gateway. Printers on the VPN need the second profile.",
      visibility: "PUBLISHED",
    })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    expect(published.body).toMatchObject({ slug: "connecting-to-the-vpn", visibility: "PUBLISHED", version: 1 })
    ids.published = published.body.id as string

    ids.internal = (
      await as("agent").post("/articles", {
        title: "VPN concentrator runbook",
        body: "Renew the lease on the concentrator.",
        visibility: "INTERNAL",
      })
    ).body.id as string
    ids.draft = (await as("agent").post("/articles", { title: "VPN printing notes", body: "Half-written notes on printing." })).body
      .id as string

    const again = await as("other").post("/articles", { title: "Connecting to the VPN", body: "A second take." })
    expect(again.body.slug).toBe("connecting-to-the-vpn-2")
    ids.again = again.body.id as string
    expect((await as("requester").post("/articles", { title: "Mine", body: "x" })).status).toBe(403)
  })

  it("edits against the version, and a stale one is 409", async () => {
    const edited = await as("other").patch(`/articles/${ids.published}`, {
      version: 1,
      body: "Open the client and sign in. Printers need the second profile.",
    })
    expect(edited.status).toBe(200)
    expect(edited.body.version).toBe(2)
    expect((await as("agent").patch(`/articles/${ids.published}`, { version: 1, title: "Too late" })).status).toBe(409)
    expect((await as("requester").patch(`/articles/${ids.published}`, { version: 2, title: "Mine now" })).status).toBe(403)
  })
})

describe("reading", () => {
  it("lists by visibility: a requester published, an agent internal and their own drafts, an admin all", async () => {
    expect(titles((await as("requester").get("/articles")).body)).toEqual(["Connecting to the VPN"])
    expect(titles((await as("other").get("/articles")).body)).toEqual([
      "Connecting to the VPN",
      "Connecting to the VPN",
      "VPN concentrator runbook",
    ])
    expect(titles((await as("agent").get("/articles")).body)).toEqual([
      "Connecting to the VPN",
      "VPN concentrator runbook",
      "VPN printing notes",
    ])
    expect((await as("admin").get("/articles")).body.items).toHaveLength(4)
  })

  it("is 404 for what the reader may not read, and counts a page view", async () => {
    expect((await as("requester").get(`/articles/${ids.internal}`)).status).toBe(404)
    expect((await as("other").get(`/articles/${ids.draft}`)).status).toBe(404)
    expect((await as("requester").get("/articles/by-slug/vpn-printing-notes")).status).toBe(404)
    await as("requester").get("/articles/by-slug/connecting-to-the-vpn")
    const page = await as("requester").get("/articles/by-slug/connecting-to-the-vpn")
    expect(page.body).toMatchObject({ viewCount: 2, capabilities: { canEdit: false, canPublish: false, canDelete: false } })
  })

  it("searches with stemming, ranks the title first, and never ranks what the reader may not open", async () => {
    // "printer" finds "Printers"; the internal runbook and the draft mention the VPN too.
    expect(titles((await as("requester").get("/articles/search?q=printer")).body)).toEqual(["Connecting to the VPN"])
    expect(titles((await as("requester").get("/articles/search?q=vpn")).body)).toEqual(["Connecting to the VPN"])
    expect(titles((await as("agent").get("/articles/search?q=vpn")).body)).toEqual([
      "Connecting to the VPN",
      "VPN concentrator runbook",
      "VPN printing notes",
    ])
    expect((await as("agent").get("/articles/search?q=concentrator")).body.items[0].title).toBe("VPN concentrator runbook")
  })
})

describe("publishing and deleting", () => {
  it("moves a draft into view, and back out", async () => {
    const draft = await as("agent").get(`/articles/${ids.draft}`)
    const published = await as("agent").patch(`/articles/${ids.draft}`, { version: draft.body.version as number, visibility: "PUBLISHED" })
    expect(published.body.publishedAt).not.toBeNull()
    expect((await as("requester").get(`/articles/${ids.draft}`)).status).toBe(200)
    const back = await as("agent").patch(`/articles/${ids.draft}`, { version: published.body.version as number, visibility: "DRAFT" })
    expect(back.body.publishedAt).toBeNull()
    expect((await as("requester").get(`/articles/${ids.draft}`)).status).toBe(404)
  })

  it("lets an agent delete their own, an admin anyone's", async () => {
    // Another agent's draft is not even there for them; their published article is, and is theirs to delete.
    expect((await as("agent").delete(`/articles/${ids.again}`)).status).toBe(404)
    expect((await as("other").delete(`/articles/${ids.published}`)).status).toBe(403)
    expect((await as("other").delete(`/articles/${ids.again}`)).status).toBe(204)
    expect((await as("admin").delete(`/articles/${ids.internal}`)).status).toBe(204)
    const trail = await db.auditLog.findMany({ where: { orgId: ws.orgId, entityType: "KnowledgeArticle", action: "ARTICLE_DELETED" } })
    expect(trail).toHaveLength(2)
  })

  it("counts articles against the plan: a free workspace's 26th is a 402", async () => {
    const counter = { orgId: ws.orgId, period: "current", metric: "KB_ARTICLES" as const }
    // Four written above, two deleted.
    expect((await db.usageCounter.findUniqueOrThrow({ where: { orgId_period_metric: counter } })).value).toBe(2n)
    await db.usageCounter.update({ where: { orgId_period_metric: counter }, data: { value: 25n } })
    const refused = await as("agent").post("/articles", { title: "One too many", body: "x" })
    expect(refused.status).toBe(402)
    expect(await db.knowledgeArticle.count({ where: { orgId: ws.orgId, title: "One too many" } })).toBe(0)
  })
})
