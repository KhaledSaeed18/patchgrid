/**
 * Notification email is at least once (ADR-0049 erratum, 2026-10-23): it is
 * queued inside the transaction that moves the `notify` cursor, so a queue
 * that refuses rolls the batch back — no inbox row without its email — and
 * the next drain delivers both. The refusal is the job's trouble, never the
 * event's: it does not count towards parking it. The relay is driven by hand,
 * with no worker running, so nothing else drains in between.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import process from "node:process"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventRelay, TransientFailure } from "../../src/events/relay"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MailService } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"requester" | "agent" | "assignee">

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
  ws = await seedWorkspace(app, db, { prefix: "mailonce", people: { requester: "REQUESTER", agent: "AGENT", assignee: "AGENT" } })
})

afterAll(async () => {
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await db.eventConsumer.deleteMany({ where: { orgId: ws.orgId } })
  await db.outboxEvent.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
  delete process.env.WORKER_MODE
})

const drain = () => runAsTenant(ws.orgId, { actor: "test", reason: "drain notify" }, () => app.get(EventRelay).drain(ws.orgId, "notify"))

it("rolls the inbox back with a refused email, and delivers both on the next drain", async () => {
  const as = (who: "requester" | "agent") => browser(app, ws.origin, ws.people[who].access)
  const created = await as("requester").post("/tickets", {
    type: "INCIDENT",
    title: "Disk full",
    description: "x",
    impact: "LOW",
    urgency: "LOW",
  })
  await as("agent").put(`/tickets/${String(created.body.id)}/assignment`, {
    version: created.body.version,
    assigneeMembershipId: ws.people.assignee.membershipId,
  })

  const mail = app.get(MailService)
  const queued: string[] = []
  const enqueueAll = mail.enqueueAll.bind(mail)
  const spy = vi
    .spyOn(mail, "enqueueAll")
    .mockRejectedValueOnce(new Error("redis refused"))
    .mockImplementation(async (mails) => {
      queued.push(...mails.map((m) => m.entityId))
      await enqueueAll(mails)
    })

  await expect(drain()).rejects.toBeInstanceOf(TransientFailure)
  const assignee = ws.people.assignee.membershipId
  expect(await db.notification.count({ where: { orgId: ws.orgId, membershipId: assignee } })).toBe(0)
  const cursor = await db.eventConsumer.findUnique({ where: { orgId_consumer: { orgId: ws.orgId, consumer: "notify" } } })
  expect(cursor?.failures ?? 0).toBe(0)

  const outcome = await drain()
  expect(outcome.kind).toBe("drained")
  expect(await db.notification.count({ where: { orgId: ws.orgId, membershipId: assignee, type: "TICKET_ASSIGNED" } })).toBe(1)
  const assigned = await db.outboxEvent.findFirstOrThrow({ where: { orgId: ws.orgId, type: "ticket-assigned" } })
  expect(queued).toContain(`${assigned.id}-${assignee}`)
  spy.mockRestore()
})
