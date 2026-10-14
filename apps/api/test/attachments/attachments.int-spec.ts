/**
 * Attachments end to end against MinIO (ADR-0005, ADR-0037): presign, the
 * browser's PUT to the files origin, completion by byte sniffing, a
 * download served as an attachment, a disguised file refused and removed,
 * the storage quota following every byte, and the sweep clearing what was
 * never finished.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { AttachmentSweepProcessor } from "../../src/jobs/maintenance/attachment-sweep"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { StorageService } from "../../src/storage/storage.service"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "requester" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let ticketId = ""
let internalNoteId = ""
const clock = new FixedClock(new Date())
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "files", people: { requester: "REQUESTER", agent: "AGENT" } })
  const created = await as("requester").post("/tickets", { type: "INCIDENT", title: "Printer error", description: "x", impact: "LOW", urgency: "LOW" })
  ticketId = created.body.id as string
  const note = await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Driver logs attached", visibility: "INTERNAL" })
  internalNoteId = note.body.id as string
})

afterAll(async () => {
  const keys = await db.attachment.findMany({ where: { orgId: ws.orgId }, select: { storageKey: true } })
  for (const { storageKey } of keys) await app.get(StorageService).remove(storageKey).catch(() => undefined)
  await db.attachment.deleteMany({ where: { orgId: ws.orgId } })
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const storageUsed = async () =>
  Number((await db.usageCounter.findFirst({ where: { orgId: ws.orgId, metric: "STORAGE_BYTES" }, select: { value: true } }))?.value ?? 0)

/** What the browser does: presign, PUT the bytes to the URL it was given, complete. */
async function upload(who: Who, file: { name: string; type: string; bytes: Uint8Array }, commentId?: string) {
  const presigned = await as(who).post("/attachments", {
    ticketId,
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.bytes.length,
    ...(commentId === undefined ? {} : { commentId }),
  })
  expect(presigned.status, JSON.stringify(presigned.body)).toBe(201)
  const put = await fetch(presigned.body.upload.url as string, { method: "PUT", headers: presigned.body.upload.headers as Record<string, string>, body: file.bytes })
  expect(put.status).toBe(200)
  return { id: presigned.body.attachment.id as string, url: presigned.body.upload.url as string, completed: await as(who).post(`/attachments/${presigned.body.attachment.id as string}/complete`, {}) }
}

describe("attachments", () => {
  it("uploads straight to the files origin, completes by its bytes, and counts against the quota", async () => {
    const before = await storageUsed()
    const { url, completed } = await upload("requester", { name: "error screen.png", type: "image/png", bytes: PNG })
    expect(new URL(url).host).toBe("localhost:9000")
    expect(completed.status).toBe(200)
    expect(completed.body).toMatchObject({ status: "READY", mimeType: "image/png", filename: "error screen.png", canDelete: true })
    expect(await storageUsed()).toBe(before + PNG.length)
    const listed = await as("agent").get(`/tickets/${ticketId}/attachments`)
    expect(listed.body.map((a: { filename: string }) => a.filename)).toEqual(["error screen.png"])
  })

  it("serves a download from the files origin, as the sniffed type", async () => {
    const id = ((await as("agent").get(`/tickets/${ticketId}/attachments`)).body[0] as { id: string }).id
    const link = await as("requester").get(`/attachments/${id}/download`)
    expect(link.body).toMatchObject({ inline: true })
    const served = await fetch(link.body.url as string)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(served.headers.get("content-disposition")).toMatch(/^inline; filename="error screen.png"/)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG)
  })

  it("serves anything that is not a raster image as a download, never inline", async () => {
    const { completed } = await upload("agent", { name: "notes.txt", type: "text/plain", bytes: new TextEncoder().encode("restarted the spooler\n") })
    const link = await as("agent").get(`/attachments/${completed.body.id as string}/download`)
    expect(link.body.inline).toBe(false)
    const served = await fetch(link.body.url as string)
    expect(served.headers.get("content-disposition")).toMatch(/^attachment; /)
  })

  it("refuses an SVG dressed as text, and leaves nothing behind — not the row, the bytes or the quota", async () => {
    const before = await storageUsed()
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    const { id, completed } = await upload("requester", { name: "harmless.txt", type: "text/plain", bytes: svg })
    expect(completed.status).toBe(400)
    expect(await db.attachment.findUnique({ where: { id } })).toBeNull()
    expect(await storageUsed()).toBe(before)
  })

  it("keeps a file on an internal note from the requester, as a 404", async () => {
    const { completed } = await upload("agent", { name: "driver.log", type: "text/plain", bytes: new TextEncoder().encode("spooler crash\n") }, internalNoteId)
    expect(completed.status).toBe(200)
    const theirs = await as("requester").get(`/tickets/${ticketId}/attachments`)
    expect(theirs.body.map((a: { filename: string }) => a.filename)).not.toContain("driver.log")
    expect((await as("requester").get(`/attachments/${completed.body.id as string}/download`)).status).toBe(404)
    expect((await as("agent").get(`/tickets/${ticketId}/attachments`)).body.map((a: { filename: string }) => a.filename)).toContain("driver.log")
  })

  it("gives the quota back when a file is removed, and the sweep clears an upload never finished", async () => {
    const files = (await as("agent").get(`/tickets/${ticketId}/attachments`)).body as { id: string; filename: string; sizeBytes: number }[]
    const notes = files.find((f) => f.filename === "notes.txt")
    const before = await storageUsed()
    expect((await as("agent").delete(`/attachments/${notes?.id ?? ""}`)).status).toBe(204)
    expect(await storageUsed()).toBe(before - (notes?.sizeBytes ?? 0))

    const abandoned = await as("requester").post("/attachments", { ticketId, filename: "never.pdf", mimeType: "application/pdf", sizeBytes: 1234 })
    expect(await storageUsed()).toBe(before - (notes?.sizeBytes ?? 0) + 1234)
    clock.advance(61 * 60_000)
    const swept = await app.get(AttachmentSweepProcessor).process({ id: "spec/sweep", data: { orgId: ws.orgId, tick: 1 } } as unknown as Job)
    expect(swept).toBe(1)
    expect(await db.attachment.findUnique({ where: { id: abandoned.body.attachment.id as string } })).toBeNull()
    expect(await storageUsed()).toBe(before - (notes?.sizeBytes ?? 0))
  })
})
