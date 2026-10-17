/**
 * Workspace export end to end (ADR-0028, ADR-0044): an owner asks, the job
 * streams a zip of every entity and every file into storage, the owner is
 * mailed a link, Settings can mint another while it lasts, and the retention
 * sweep takes the archive away when the link lapses.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import { unzipSync } from "fflate"
import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { EXPORT_QUEUE } from "../../src/exports/exports.service"
import { RetentionSweepProcessor } from "../../src/jobs/maintenance/retention-sweep"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { StorageService } from "../../src/storage/storage.service"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "admin" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
let storage: StorageService
const recorder = new RecordingMailProvider()
const FILE = new TextEncoder().encode("router config, sanitised\n")
let ticketId = ""
let exportId = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  storage = app.get(StorageService)
  ws = await seedWorkspace(app, db, { prefix: "export", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT" } })
  jobs = settler(app, [EXPORT_QUEUE, MAIL_QUEUE])
  ticketId = (await as("agent").post("/tickets", { type: "INCIDENT", title: "Router down", description: "x", impact: "LOW", urgency: "LOW" })).body.id as string
  await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Kept from the requester.", visibility: "INTERNAL" })
  const storageKey = `org/${ws.orgId}/tickets/${ticketId}/0190-router.conf`
  await storage.put(storageKey, FILE, "text/plain")
  await db.attachment.create({
    data: { orgId: ws.orgId, ticketId, uploaderMembershipId: ws.people.agent.membershipId, filename: "router.conf", declaredMimeType: "text/plain", mimeType: "text/plain", sizeBytes: FILE.length, storageKey, status: "READY", completedAt: new Date() },
  })
  await db.invitation.create({
    data: { orgId: ws.orgId, email: "later@probe.test", role: "AGENT", tokenHash: "a-secret-hash-that-never-leaves", expiresAt: new Date(Date.now() + 86_400_000), invitedByMembershipId: ws.people.owner.membershipId },
  })
})

afterAll(async () => {
  await storage?.removePrefix(`org/${ws.orgId}/`)
  for (const table of ["orgExport", "attachment", "notification", "comment", "ticketWatcher", "ticket", "ticketCounter", "invitation"] as const) {
    await (db[table] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({ where: { orgId: ws.orgId } })
  }
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)

describe("asking", () => {
  it("is an owner's alone, at most once a day", async () => {
    expect((await as("admin").post("/org/exports")).status).toBe(403)
    const asked = await as("owner").post("/org/exports")
    expect(asked.status, JSON.stringify(asked.body)).toBe(202)
    expect(asked.body).toMatchObject({ status: "QUEUED", requestedBy: { id: ws.people.owner.membershipId } })
    exportId = asked.body.id as string
    const again = await as("owner").post("/org/exports")
    expect(again.status).toBe(429)
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(80_000)
    const audit = await db.auditLog.findFirst({ where: { orgId: ws.orgId, action: "ORG_EXPORTED" } })
    expect(audit).toMatchObject({ actorMembershipId: ws.people.owner.membershipId, diff: { exportId } })
  })
})

describe("the archive", () => {
  it("is built, mailed to the owner who asked, and listed as ready", async () => {
    await jobs.settle()
    const listed = await as("owner").get("/org/exports")
    expect(listed.body).toEqual([expect.objectContaining({ id: exportId, status: "READY", sizeBytes: expect.any(Number), expiresAt: expect.any(String) })])
    expect(recorder.sent.filter((m) => m.to === ws.people.owner.email).map((m) => m.subject)).toEqual([expect.stringMatching(/export of .* is ready/)])
    expect((await as("owner").get(`/org/exports/${exportId}/download`)).body).toMatchObject({ url: expect.stringContaining("exports") })
  })

  it("holds every entity, internal notes and every file — and no secret", async () => {
    const row = await db.orgExport.findUniqueOrThrow({ where: { id: exportId } })
    const stream = await storage.openRead(row.storageKey ?? "")
    const chunks: Buffer[] = []
    for await (const chunk of stream ?? []) chunks.push(chunk as Buffer)
    const files = unzipSync(new Uint8Array(Buffer.concat(chunks)))
    const text = (name: string) => new TextDecoder().decode(files[name])
    const lines = (name: string) => text(name).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>)

    const manifest = JSON.parse(text("manifest.json")) as { workspace: { slug: string }; files: Record<string, number> }
    expect(manifest.workspace.slug).toBe(ws.slug)
    expect(manifest.files).toMatchObject({ "tickets.ndjson": 1, "comments.ndjson": 1, "members.ndjson": 3, "attachments.ndjson": 1, "invitations.ndjson": 1 })
    expect(lines("tickets.ndjson")[0]).toMatchObject({ id: ticketId, title: "Router down" })
    expect(lines("comments.ndjson")[0]).toMatchObject({ visibility: "INTERNAL", body: "Kept from the requester." })
    expect(lines("members.ndjson").map((m) => m.email)).toEqual(expect.arrayContaining([ws.people.owner.email]))

    const [attachment] = lines("attachments.ndjson")
    expect(attachment).toMatchObject({ filename: "router.conf", sha256: createHash("sha256").update(FILE).digest("hex") })
    expect(attachment).not.toHaveProperty("storageKey")
    expect(files[String(attachment?.path)]).toEqual(FILE)

    const everything = Object.values(files).map((f) => new TextDecoder().decode(f)).join("\n")
    expect(everything).not.toContain("a-secret-hash-that-never-leaves")
    expect(everything).not.toContain("tokenHash")
  })
})

describe("retention", () => {
  it("takes the archive away when the link lapses, and old notifications with it", async () => {
    await db.orgExport.update({ where: { id: exportId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const key = (await db.orgExport.findUniqueOrThrow({ where: { id: exportId } })).storageKey ?? ""
    await db.notification.create({
      data: { orgId: ws.orgId, userId: ws.people.agent.userId, membershipId: ws.people.agent.membershipId, type: "TICKET_ASSIGNED", ticketId, dedupeKey: "old", title: "Old", createdAt: new Date(Date.now() - 91 * 86_400_000) },
    })
    const swept = await app.get(RetentionSweepProcessor).process({ id: "retention/test", data: { orgId: ws.orgId, tick: 1 } } as unknown as Job)
    expect(swept).toEqual({ notifications: 1, exports: 1, deliveries: 0, events: 0 })
    expect(await storage.size(key)).toBeNull()
    expect((await as("owner").get("/org/exports")).body[0]).toMatchObject({ status: "EXPIRED" })
    expect((await as("owner").get(`/org/exports/${exportId}/download`)).status).toBe(409)
  })
})
