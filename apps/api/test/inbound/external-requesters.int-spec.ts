/**
 * External requesters (ADR-0027 §4), through the booted app and its workers:
 * off by default; once a workspace takes outside mail, an authenticated
 * address that is no member's raises a ticket as an external requester — a
 * membership with no account — hears back by email, threads replies onto
 * their own ticket, and is stopped by an admin pausing them.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { OUTBOX_DRAIN_QUEUE } from "../../src/events/drain-requests"
import { INBOUND_QUEUE } from "../../src/inbound/inbound-receiver.service"
import { INBOUND_WEBHOOK_PATH, inboundBodyParser } from "../../src/inbound/inbound.controller"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { StorageService } from "../../src/storage/storage.service"
import { buildMessage, type SampleMail, webhookRequest } from "../support/inbound-mail"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

const SECRET = requireEnv("INBOUND_WEBHOOK_SECRET")
const AUTHSERV = requireEnv("INBOUND_AUTHSERV_ID")
let db: PrismaClient
let app: INestApplication
let ws: Workspace<"admin" | "agent">
let jobs: Settler
const recorder = new RecordingMailProvider()
const carla = `carla-${randomUUID().slice(0, 8)}@contractor.test`

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.use(INBOUND_WEBHOOK_PATH, inboundBodyParser())
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "external", people: { admin: "ADMIN", agent: "AGENT" } })
  jobs = settler(app, [INBOUND_QUEUE, OUTBOX_DRAIN_QUEUE, MAIL_QUEUE])
})

afterAll(async () => {
  const keys = await db.inboundEmail.findMany({ where: { orgId: ws.orgId }, select: { rawStorageKey: true } })
  for (const { rawStorageKey } of keys) await app.get(StorageService).remove(rawStorageKey).catch(() => undefined)
  await db.inboundEmail.deleteMany({ where: { orgId: ws.orgId } })
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await db.auditLog.deleteMany({ where: { orgId: ws.orgId } })
  await db.membership.deleteMany({ where: { orgId: ws.orgId, kind: "EXTERNAL" } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const address = () => `${ws.slug}@inbound.lvh.me`
const as = (who: "admin" | "agent") => browser(app, ws.origin, ws.people[who].access)
async function deliver(mail: Omit<SampleMail, "authservId" | "to">) {
  const signed = webhookRequest(SECRET, [address()], buildMessage({ authservId: AUTHSERV, to: address(), ...mail }))
  await request(app.getHttpServer()).post(INBOUND_WEBHOOK_PATH).set(signed.headers).send(signed.body.toString("utf8"))
  await jobs.settle()
}
const latest = () => db.inboundEmail.findFirstOrThrow({ where: { orgId: ws.orgId }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }] })
const external = () => db.membership.findFirst({ where: { orgId: ws.orgId, kind: "EXTERNAL", contactEmail: carla } })

it("drops outside mail by default, and makes nobody of it", async () => {
  await deliver({ from: carla, subject: "Badge does not open the gate", text: "Since Monday." })
  expect(await latest()).toMatchObject({ outcome: "UNKNOWN_SENDER" })
  expect(await external()).toBeNull()
})

it("raises a ticket for an external requester once the workspace takes outside mail, and hears back by email", async () => {
  expect((await as("admin").patch("/org/settings", { allowExternalRequesters: true })).body.allowExternalRequesters).toBe(true)
  const sent = recorder.sent.length
  await deliver({ from: carla, subject: "Badge does not open the gate", text: "Since Monday, at the north gate." })
  const row = await latest()
  expect(row).toMatchObject({ outcome: "CREATED" })
  const membership = await external()
  expect(membership).toMatchObject({ kind: "EXTERNAL", role: "REQUESTER", status: "ACTIVE", userId: null, contactEmail: carla })
  expect(row.senderMembershipId).toBe(membership?.id)

  const ticket = await as("agent").get(`/tickets/${String(row.ticketId)}`)
  expect(ticket.body.requester).toMatchObject({ membershipId: membership?.id, external: true })
  // The requester's confirmation goes to the address they wrote from; nobody gets an inbox row for them.
  expect(recorder.sent.slice(sent).map((m) => m.to)).toContain(carla)
  expect(await db.notification.count({ where: { orgId: ws.orgId, membershipId: membership?.id ?? "" } })).toBe(0)

  // An agent's public reply reaches them, and their answer threads back onto their own ticket.
  const before = recorder.sent.length
  await as("agent").post(`/tickets/${String(row.ticketId)}/comments`, { body: "Which badge number?", visibility: "PUBLIC" })
  await jobs.settle()
  const notice = recorder.sent.slice(before).find((m) => m.to === carla)
  expect(notice).toBeDefined()
  await deliver({ from: carla, subject: `Re: ${notice?.subject ?? ""}`, text: "Badge 4411.", inReplyTo: notice?.messageId ?? "" })
  expect(await latest()).toMatchObject({ outcome: "THREADED", ticketId: row.ticketId })
  const thread = await as("agent").get(`/tickets/${String(row.ticketId)}/comments`)
  expect((thread.body as { body: string; author: { membershipId: string } | null }[]).at(-1)).toMatchObject({ body: "Badge 4411.", author: { membershipId: membership?.id } })
})

it("lists the external requester for admins, who stop their mail by pausing them", async () => {
  const membership = await external()
  const members = await as("admin").get("/members?limit=100")
  const listed = (members.body.items as { id: string; kind: string; contact: { email: string | null } | null; capabilities: { canDisable: boolean; roles: string[] } }[]).find((m) => m.id === membership?.id)
  expect(listed).toMatchObject({ kind: "EXTERNAL", contact: { email: carla }, capabilities: { canDisable: true, roles: [] } })

  expect((await as("admin").post(`/members/${String(membership?.id)}/disable`)).status).toBe(200)
  await deliver({ from: carla, subject: "Still broken", text: "Hello?" })
  expect(await latest()).toMatchObject({ outcome: "UNKNOWN_SENDER" })
})
