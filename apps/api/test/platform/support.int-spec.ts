/**
 * Consent-based support access end to end (ADR-0020, ADR-0041): an operator
 * asks, an owner grants, the operator reads the workspace through its own
 * routes as a read-only support actor — internal notes included, nothing
 * writable, every request in the workspace's own audit log — until an owner
 * revokes it or its time runs out.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { SupportReadLog } from "../../src/auth/support/support-read-log"
import { SupportSweepProcessor } from "../../src/support/support-sweep"
import { type Operator, signInOperator } from "../support/platform"
import { type Settler, settler } from "../support/queues"
import { browser, HEADERS, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "admin" | "agent" | "requester"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let operator: Operator
let jobs: Settler
const recorder = new RecordingMailProvider()
let ticketId = ""
let sessionId = ""
let supportCookie = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "consent", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT", requester: "REQUESTER" } })
  operator = await signInOperator(app, db)
  jobs = settler(app, [MAIL_QUEUE])
  ticketId = (await as("requester").post("/tickets", { type: "INCIDENT", title: "VPN drops", description: "x", impact: "LOW", urgency: "LOW" })).body.id as string
  await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Looks like the concentrator lease.", visibility: "INTERNAL" })
})

afterAll(async () => {
  await app.get(SupportReadLog).drain()
  await db.supportSession.deleteMany({ where: { orgId: ws.orgId } })
  await operator?.cleanup()
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const asSupport = () => ({
  get: (path: string) => request(app.getHttpServer()).get(`/api/v1${path}`).set("Origin", ws.origin).set("Cookie", supportCookie),
  post: (path: string, body: object = {}) =>
    request(app.getHttpServer()).post(`/api/v1${path}`).set(HEADERS).set("Origin", ws.origin).set("Cookie", supportCookie).send(body),
})
const ownerMail = async () => {
  await jobs.settle()
  return recorder.sent.filter((m) => m.to === ws.people.owner.email).map((m) => m.subject)
}

describe("asking and granting", () => {
  it("lets an operator ask, with a reason the owners read, and nothing is readable yet", async () => {
    const asked = await operator.post(`/orgs/${ws.orgId}/support`, { reason: "Diagnose the VPN ticket the owner reported" })
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    expect(asked.body).toMatchObject({ status: "REQUESTED", operator: { name: "Olga Operator" } })
    sessionId = asked.body.id as string
    expect(await ownerMail()).toEqual([expect.stringMatching(/asked to read/)])
    expect((await operator.post(`/orgs/${ws.orgId}/support/${sessionId}/enter`)).status).toBe(409)
    const seen = await as("admin").get("/org/support-sessions")
    expect(seen.body).toEqual([expect.objectContaining({ id: sessionId, status: "REQUESTED", reason: "Diagnose the VPN ticket the owner reported" })])
    expect((await as("agent").get("/org/support-sessions")).status).toBe(403)
  })

  it("is granted by an owner only, for at most 72 hours", async () => {
    expect((await as("admin").post(`/org/support-sessions/${sessionId}/grant`, { hours: 2 })).status).toBe(403)
    expect((await as("owner").post(`/org/support-sessions/${sessionId}/grant`, { hours: 73 })).status).toBe(400)
    const granted = await as("owner").post(`/org/support-sessions/${sessionId}/grant`, { hours: 2 })
    expect(granted.body).toMatchObject({ status: "ACTIVE" })
    expect(await ownerMail()).toContainEqual(expect.stringMatching(/can now read/))
  })
})

describe("reading as support", () => {
  it("enters the workspace and reads as an admin reads — internal notes included", async () => {
    const entered = await operator.post(`/orgs/${ws.orgId}/support/${sessionId}/enter`)
    expect(entered.status).toBe(200)
    supportCookie = String(entered.headers["set-cookie"]).split(";")[0] ?? ""
    expect(supportCookie).toMatch(new RegExp(`^pg_st_${ws.slug}=`))
    const me = await asSupport().get("/me")
    expect(me.body).toMatchObject({ user: null, support: { kind: "operator", operatorName: "Olga Operator" }, creatableTypes: [] })
    expect((await asSupport().get("/tickets?view=all")).body.items.map((t: { id: string }) => t.id)).toContain(ticketId)
    const thread = await asSupport().get(`/tickets/${ticketId}/comments`)
    expect(thread.body.map((c: { visibility: string }) => c.visibility)).toContain("INTERNAL")
    expect(await ownerMail()).toContainEqual(expect.stringMatching(/is reading/))
  })

  it("writes nothing, and every request — the refused ones too — is in the workspace's own log", async () => {
    const write = await asSupport().post("/tickets", { type: "INCIDENT", title: "x", description: "x", impact: "LOW", urgency: "LOW" })
    expect(write.status).toBe(403)
    // Recorded as each response finishes; wait for those writes rather than for time.
    await app.get(SupportReadLog).drain()
    const reads = await db.auditLog.findMany({ where: { orgId: ws.orgId, action: "SUPPORT_READ", supportSessionId: sessionId }, orderBy: { createdAt: "asc" } })
    expect(reads.length).toBeGreaterThanOrEqual(4)
    expect(reads.every((r) => r.actorKind === "PLATFORM" && r.actorPlatformAdminId === operator.platformAdminId)).toBe(true)
    expect(reads.map((r) => r.diff)).toContainEqual(expect.objectContaining({ endpoint: "GET /api/v1/tickets/:id/comments", status: 200 }))
    expect(reads.map((r) => r.diff)).toContainEqual(expect.objectContaining({ endpoint: "POST /api/v1/tickets", status: 403 }))
    // The workspace's admins see it happening.
    expect((await as("admin").get("/me")).body.support).toMatchObject({ kind: "watched", operatorName: "Olga Operator" })
    expect((await as("agent").get("/me")).body.support).toBeNull()
  })

  it("ends on an owner's word, at once", async () => {
    expect((await as("owner").post(`/org/support-sessions/${sessionId}/revoke`)).body).toMatchObject({ status: "ENDED", endReason: "REVOKED" })
    expect((await asSupport().get("/tickets?view=all")).status).toBe(401)
    expect(await ownerMail()).toContainEqual(expect.stringMatching(/has ended/))
  })
})

describe("declining and expiry", () => {
  it("can be declined, and expires on its own, on the record", async () => {
    const declined = (await operator.post(`/orgs/${ws.orgId}/support`, { reason: "Another look at the VPN ticket" })).body.id as string
    expect((await as("owner").post(`/org/support-sessions/${declined}/decline`)).body.status).toBe("DECLINED")
    expect((await as("owner").post(`/org/support-sessions/${declined}/grant`, { hours: 1 })).status).toBe(409)

    const expiring = (await operator.post(`/orgs/${ws.orgId}/support`, { reason: "A third look at the VPN ticket" })).body.id as string
    await as("owner").post(`/org/support-sessions/${expiring}/grant`, { hours: 1 })
    await db.supportSession.update({ where: { id: expiring }, data: { grantedAt: new Date(Date.now() - 2 * 3_600_000), expiresAt: new Date(Date.now() - 3_600_000) } })
    const ended = await app.get(SupportSweepProcessor).process({ id: "spec/support-sweep", data: { orgId: ws.orgId, tick: 1 } } as unknown as Job)
    expect(ended).toBe(1)
    expect(await db.supportSession.findUnique({ where: { id: expiring } })).toMatchObject({ endReason: "EXPIRED" })
    expect(await db.auditLog.count({ where: { orgId: ws.orgId, action: "SUPPORT_ACCESS_EXPIRED", entityId: expiring } })).toBe(1)
  })
})
