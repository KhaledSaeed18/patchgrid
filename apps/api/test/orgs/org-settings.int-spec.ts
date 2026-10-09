/**
 * Organization settings and the slug change through the booted app: agent
 * visibility reaches the cached summary, a rename reaches the picker, and a
 * slug change moves the owner's session to the new name, leaves the old slug
 * redirecting and reserved, and is refused again inside the cooldown.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"owner" | "admin" | "agent">
const newSlug = `moved-${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()
  ws = await seedWorkspace(app, db, { prefix: "settings", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT" } })
})

afterAll(async () => {
  await db.organizationSlugHistory.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

describe("organization settings", () => {
  it("agents read them; admins change them, with agent visibility reaching resolution at once", async () => {
    const read = await browser(app, ws.origin, ws.people.agent.access).get("/org/settings")
    expect(read.body).toMatchObject({ id: ws.orgId, slug: ws.slug, agentVisibility: "ALL_TICKETS", slugChangeAvailableAt: null })
    expect((await browser(app, ws.origin, ws.people.agent.access).patch("/org/settings", { name: "Nope" })).status).toBe(403)

    // Warm the cached summary, then change what it caches.
    expect((await browser(app, ws.origin, ws.people.agent.access).get("/me")).body.org.agentVisibility).toBe("ALL_TICKETS")
    const updated = await browser(app, ws.origin, ws.people.admin.access).patch("/org/settings", {
      name: "Renamed",
      agentVisibility: "OWN_TEAM_ONLY",
    })
    expect(updated.body).toMatchObject({ name: "Renamed", agentVisibility: "OWN_TEAM_ONLY" })
    expect((await browser(app, ws.origin, ws.people.agent.access).get("/me")).body.org).toMatchObject({
      name: "Renamed",
      agentVisibility: "OWN_TEAM_ONLY",
    })
    expect((await db.userOrgIndex.findFirstOrThrow({ where: { orgId: ws.orgId } })).orgName).toBe("Renamed")
  })

  it("only the owner changes the slug; the session moves, the old slug redirects and stays reserved", async () => {
    expect((await browser(app, ws.origin, ws.people.admin.access).post("/org/slug", { slug: newSlug })).status).toBe(403)

    const moved = await browser(app, ws.origin, ws.people.owner.access).post("/org/slug", { slug: newSlug })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ slug: newSlug, previousSlug: ws.slug, session: { slug: newSlug } })
    const cookies = (moved.headers["set-cookie"] as unknown as string[]).map((c) => c.split(";")[0] ?? "")
    expect(cookies).toContain(`pg_at_${ws.slug}=`)
    const access = cookies.find((c) => c.startsWith(`pg_at_${newSlug}=`)) ?? ""
    expect(access).not.toBe("")

    const newOrigin = `http://${newSlug}.lvh.me:3001`
    expect((await browser(app, newOrigin, access).get("/me")).body.org).toMatchObject({ id: ws.orgId, slug: newSlug })
    expect((await request(app.getHttpServer()).get(`/api/v1/tenants/${ws.slug}`)).body).toEqual({
      status: "moved",
      slug: ws.slug,
      currentSlug: newSlug,
    })
    expect((await request(app.getHttpServer()).get(`/api/v1/orgs/slug-available?slug=${ws.slug}`)).body.reason).toBe("taken")
    expect((await db.userOrgIndex.findFirstOrThrow({ where: { orgId: ws.orgId } })).orgSlug).toBe(newSlug)

    const again = await browser(app, newOrigin, access).post("/org/slug", { slug: `${newSlug}-x` })
    expect(again.status).toBe(409)
    expect((await browser(app, newOrigin, access).get("/org/settings")).body.slugChangeAvailableAt).not.toBeNull()
  })

  it("audited every change", async () => {
    const actions = (await db.auditLog.findMany({ where: { orgId: ws.orgId }, select: { action: true } })).map((a) => a.action)
    expect(actions.toSorted()).toEqual(["AGENT_VISIBILITY_CHANGED", "ORG_SETTINGS_UPDATED", "ORG_SLUG_CHANGED"])
  })
})
