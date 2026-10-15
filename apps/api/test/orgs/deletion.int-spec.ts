/**
 * Deleting a workspace (ADR-0043), through the routes: an owner asks by
 * typing the slug; everyone is out and the subdomain 404s; the picker shows
 * the owners when it will be purged; an owner — and only an owner — takes it
 * back from there, or an operator does from the back-office.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { type Operator, signInOperator } from "../support/platform"
import { type Settler, settler } from "../support/queues"
import { browser, HEADERS, seedWorkspace, stepUp, type Workspace } from "../support/workspace"

type Who = "owner" | "admin" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let operator: Operator
let jobs: Settler
const recorder = new RecordingMailProvider()

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "deleting", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT" } })
  operator = await signInOperator(app, db)
  jobs = settler(app, [MAIL_QUEUE])
})

afterAll(async () => {
  await operator?.cleanup()
  await db.platformAuditLog.deleteMany({ where: { targetOrgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
/** The same person, re-proved for the next five minutes (ADR-0029). */
const proved = async (who: Who) => browser(app, ws.origin, await stepUp(app, ws.slug, ws.people[who]))
const picker = (who: Who) => ({
  get: () => request(app.getHttpServer()).get("/api/v1/auth/identity").set("Cookie", ws.people[who].pgId),
  cancel: () => request(app.getHttpServer()).post(`/api/v1/orgs/${ws.orgId}/cancel-deletion`).set(HEADERS).set("Cookie", ws.people[who].pgId),
  open: () => request(app.getHttpServer()).post("/api/v1/auth/sessions").set(HEADERS).set("Cookie", ws.people[who].pgId).send({ slug: ws.slug }),
})
const mailFor = async (who: Who) => {
  await jobs.settle()
  return recorder.sent.filter((m) => m.to === ws.people[who].email).map((m) => m.subject)
}

describe("asking", () => {
  it("is an owner's alone, freshly proved, and only with the workspace's own slug typed", async () => {
    expect((await as("admin").post("/org/deletion", { confirmSlug: ws.slug })).status).toBe(403)
    const unproved = await as("owner").post("/org/deletion", { confirmSlug: ws.slug })
    expect(unproved.status).toBe(403)
    expect(unproved.body.type).toContain("step-up-required")
    expect((await (await proved("owner")).post("/org/deletion", { confirmSlug: "not-this-one" })).status).toBe(400)
    expect((await db.organization.findUniqueOrThrow({ where: { id: ws.orgId } })).status).toBe("ACTIVE")
  })

  it("puts everyone out at once, and the subdomain answers as if it never existed", async () => {
    expect((await (await proved("owner")).post("/org/deletion", { confirmSlug: ws.slug })).status).toBe(202)
    expect((await as("agent").get("/me")).status).toBe(404)
    expect((await request(app.getHttpServer()).get(`/api/v1/tenants/${ws.slug}`)).status).toBe(404)
    expect((await picker("agent").open()).status).toBe(404)
    expect(await mailFor("owner")).toEqual([expect.stringMatching(/will be deleted on/)])
    expect(await mailFor("admin")).toEqual([expect.stringMatching(/will be deleted on/)])
    expect(await mailFor("agent")).toEqual([])
  })

  it("shows its owners, in the picker, when it will be purged", async () => {
    const listed = (await picker("owner").get()).body.workspaces.find((w: { orgId: string }) => w.orgId === ws.orgId)
    expect(listed).toMatchObject({ orgStatus: "PENDING_DELETION", purgeAt: expect.any(String) })
    const days = (Date.parse(listed.purgeAt as string) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)
  })
})

describe("taking it back", () => {
  it("is refused to anyone who is not an owner of it — with the picker's 404", async () => {
    expect((await picker("admin").cancel()).status).toBe(404)
    expect((await picker("agent").cancel()).status).toBe(404)
  })

  it("lets an owner cancel from the picker; the workspace returns as it was, old sessions do not", async () => {
    expect((await picker("owner").cancel()).status).toBe(204)
    expect((await db.organization.findUniqueOrThrow({ where: { id: ws.orgId } })).status).toBe("ACTIVE")
    expect((await as("owner").get("/me")).status).toBe(401)
    expect((await picker("agent").open()).status).toBe(200)
    expect(await mailFor("admin")).toEqual([expect.stringMatching(/will be deleted on/), expect.stringMatching(/will not be deleted/)])
    expect((await picker("owner").cancel()).status).toBe(404)
    const audit = await db.auditLog.findMany({ where: { orgId: ws.orgId, entityType: "Organization" }, orderBy: { createdAt: "asc" } })
    expect(audit.map((a) => [a.action, a.actorMembershipId])).toEqual([
      ["ORG_DELETION_REQUESTED", ws.people.owner.membershipId],
      ["ORG_DELETION_CANCELLED", ws.people.owner.membershipId],
    ])
  })

  it("lets an operator restore it from the back-office, on both records", async () => {
    await db.organization.update({ where: { id: ws.orgId }, data: { status: "PENDING_DELETION", deletionRequestedAt: new Date() } })
    const restored = await operator.post(`/orgs/${ws.orgId}/restore`)
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect(restored.body).toMatchObject({ status: "ACTIVE", purgeAt: null })
    expect(await db.platformAuditLog.findFirst({ where: { targetOrgId: ws.orgId, action: "PLATFORM_ORG_DELETION_RESTORED" } })).not.toBeNull()
    expect((await operator.post(`/orgs/${ws.orgId}/restore`)).status).toBe(409)
  })

  it("is closed from the purge date on: the purge owns it then", async () => {
    await db.organization.update({ where: { id: ws.orgId }, data: { status: "PENDING_DELETION", deletionRequestedAt: new Date(Date.now() - 30 * 86_400_000) } })
    expect((await picker("owner").cancel()).status).toBe(409)
    expect((await operator.post(`/orgs/${ws.orgId}/restore`)).status).toBe(409)
    await db.organization.update({ where: { id: ws.orgId }, data: { status: "ACTIVE", deletionRequestedAt: null } })
  })
})
