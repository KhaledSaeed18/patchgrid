/**
 * Replaying a parked event (ADR-0049, THREAT-MODEL §8), through the booted
 * app with no worker: an admin sees what the `notify` consumer gave up on,
 * replays it once the cause is fixed, and the inbox row it never wrote
 * appears. Another workspace's admin cannot see or replay it, an agent may
 * not, and a second replay is a conflict.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import process from "node:process"
import { afterAll, beforeAll, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let acme: Workspace<"admin" | "agent" | "requester">
let globex: Workspace<"admin">

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  acme = await seedWorkspace(app, db, { prefix: "dlq", people: { admin: "ADMIN", agent: "AGENT", requester: "REQUESTER" } })
  globex = await seedWorkspace(app, db, { prefix: "dlqx", people: { admin: "ADMIN" } })
})

afterAll(async () => {
  for (const ws of [acme, globex]) {
    if (ws === undefined) continue
    await db.auditLog.deleteMany({ where: { orgId: ws.orgId } })
    await db.notification.deleteMany({ where: { orgId: ws.orgId } })
    await db.eventDeadLetter.deleteMany({ where: { orgId: ws.orgId } })
    await db.eventConsumer.deleteMany({ where: { orgId: ws.orgId } })
    await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
    await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
    await db.outboxEvent.deleteMany({ where: { orgId: ws.orgId } })
    await ws.cleanup()
  }
  await app?.close()
  await db.$disconnect()
  delete process.env.WORKER_MODE
})

it("replays a parked event once, for this workspace's admins alone", async () => {
  const as = (ws: Workspace<string>, who: string) => browser(app, ws.origin, ws.people[who]?.access ?? "")
  const created = await as(acme, "requester").post("/tickets", {
    type: "INCIDENT",
    title: "Badge reader",
    description: "x",
    impact: "LOW",
    urgency: "LOW",
  })
  await as(acme, "agent").put(`/tickets/${String(created.body.id)}/assignment`, {
    version: created.body.version,
    assigneeMembershipId: acme.people.admin.membershipId,
  })
  const event = await db.outboxEvent.findFirstOrThrow({ where: { orgId: acme.orgId, type: "ticket-assigned" } })

  // The consumer gave up on it: parked, and the cursor past it, as the relay leaves them.
  await db.eventDeadLetter.create({
    data: { orgId: acme.orgId, consumer: "notify", eventId: event.id, failures: 3, error: "gave up after repeated failures" },
  })
  await db.eventConsumer.create({ data: { orgId: acme.orgId, consumer: "notify", cursorTxn: event.txn, cursorEventId: event.id } })
  const assigned = () =>
    db.notification.count({ where: { orgId: acme.orgId, membershipId: acme.people.admin.membershipId, type: "TICKET_ASSIGNED" } })
  expect(await assigned()).toBe(0)

  const list = await as(acme, "admin").get("/org/events/dead-letters")
  expect(list.status).toBe(200)
  expect(list.body.items).toEqual([
    expect.objectContaining({ consumer: "notify", eventId: event.id, eventType: "ticket-assigned", replayedAt: null }),
  ])
  const id = String(list.body.items[0].id)

  expect((await as(acme, "agent").get("/org/events/dead-letters")).status).toBe(403)
  expect((await as(acme, "agent").post(`/org/events/dead-letters/${id}/replay`, {})).status).toBe(403)
  expect((await as(globex, "admin").get("/org/events/dead-letters")).body.items).toEqual([])
  expect((await as(globex, "admin").post(`/org/events/dead-letters/${id}/replay`, {})).status).toBe(404)

  const replayed = await as(acme, "admin").post(`/org/events/dead-letters/${id}/replay`, {})
  expect(replayed.status).toBe(200)
  expect(replayed.body.replayedAt).not.toBeNull()
  expect(await assigned()).toBe(1)
  expect(await db.auditLog.count({ where: { orgId: acme.orgId, action: "EVENT_REPLAYED", entityId: id } })).toBe(1)

  const again = await as(acme, "admin").post(`/org/events/dead-letters/${id}/replay`, {})
  expect(again.status).toBe(409)
  expect(await assigned()).toBe(1)
})
