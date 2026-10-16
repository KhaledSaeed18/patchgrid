/**
 * Email intake end to end (ADR-0027, ADR-0039), through the booted app and
 * its workers: the signed webhook, the tenant from the envelope, the verdict
 * from our receiver's Authentication-Results, the sender as the member they
 * are — and a reply to our own notification threading back onto its ticket,
 * while knowing a ticket's number earns nothing more than a ticket of one's own.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { SENDER_HOURLY_LIMIT } from "../../src/inbound/inbound-intake.service"
import { InboundSweepProcessor } from "../../src/inbound/inbound-sweep"
import { INBOUND_QUEUE } from "../../src/inbound/inbound-receiver.service"
import { INBOUND_WEBHOOK_PATH, inboundBodyParser } from "../../src/inbound/inbound.controller"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { NOTIFY_QUEUE } from "../../src/notifications/notify"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { StorageService } from "../../src/storage/storage.service"
import { buildMessage, type SampleMail, webhookRequest } from "../support/inbound-mail"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "rita" | "rosa" | "agent" | "admin"

const SECRET = requireEnv("INBOUND_WEBHOOK_SECRET")
const AUTHSERV = requireEnv("INBOUND_AUTHSERV_ID")
let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
const recorder = new RecordingMailProvider()
let ritasTicket = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(recorder)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.use(INBOUND_WEBHOOK_PATH, inboundBodyParser())
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "intake", people: { rita: "REQUESTER", rosa: "REQUESTER", agent: "AGENT", admin: "ADMIN" } })
  jobs = settler(app, [INBOUND_QUEUE, NOTIFY_QUEUE, MAIL_QUEUE])
})

afterAll(async () => {
  const keys = await db.inboundEmail.findMany({ where: { orgId: ws.orgId }, select: { rawStorageKey: true } })
  const files = await db.attachment.findMany({ where: { orgId: ws.orgId }, select: { storageKey: true } })
  for (const key of [...keys.map((k) => k.rawStorageKey), ...files.map((f) => f.storageKey)]) {
    await app.get(StorageService).remove(key).catch(() => undefined)
  }
  await db.inboundEmail.deleteMany({ where: { orgId: ws.orgId } })
  await db.attachment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketLink.deleteMany({ where: { orgId: ws.orgId } })
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const address = () => `${ws.slug}@inbound.lvh.me`
const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)

/** Posts a message as the receiving MTA would, and waits for everything it sets off. */
async function deliver(mail: Omit<SampleMail, "authservId" | "to">, options: { recipients?: string[]; secret?: string } = {}) {
  const raw = buildMessage({ authservId: AUTHSERV, to: address(), ...mail })
  const signed = webhookRequest(options.secret ?? SECRET, options.recipients ?? [address()], raw)
  // As a string: supertest would JSON-encode a Buffer, and the signature is over the bytes sent.
  const response = await request(app.getHttpServer()).post(INBOUND_WEBHOOK_PATH).set(signed.headers).send(signed.body.toString("utf8"))
  await jobs.settle()
  return response
}
const latest = () => db.inboundEmail.findFirstOrThrow({ where: { orgId: ws.orgId }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }] })

describe("the webhook", () => {
  it("refuses an unsigned or mis-signed delivery before reading it", async () => {
    const raw = buildMessage({ authservId: AUTHSERV, to: address(), from: ws.people.rita.email, subject: "x", text: "x" })
    const signed = webhookRequest(SECRET, [address()], raw)
    expect((await request(app.getHttpServer()).post(INBOUND_WEBHOOK_PATH).send(signed.body)).status).toBe(401)
    const forged = await deliver({ from: ws.people.rita.email, subject: "x", text: "x" }, { secret: "whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==" })
    expect(forged.status).toBe(401)
    expect(await db.inboundEmail.count({ where: { orgId: ws.orgId } })).toBe(0)
  })

  it("answers 202 for a recipient that is no workspace, and records nothing", async () => {
    const response = await deliver({ from: ws.people.rita.email, subject: "x", text: "x" }, { recipients: ["no-such-workspace@inbound.lvh.me"] })
    expect(response.status).toBe(202)
    expect(await db.inboundEmail.count({ where: { orgId: ws.orgId } })).toBe(0)
  })
})

describe("a new ticket", () => {
  it("is raised as the authenticated member, from the subject and the text, with the files that pass", async () => {
    const response = await deliver({
      from: ws.people.rita.email,
      subject: "Fwd: Printer on floor 3 says offline",
      text: "It shows offline from every laptop.",
      messageId: "<printer-1@mail.test>",
      attachments: [
        { filename: "spooler.log", contentType: "text/plain", content: Buffer.from("spooler crash at 09:00\n") },
        { filename: "pretty.svg", contentType: "image/svg+xml", content: Buffer.from("<svg onload=alert(1)/>") },
      ],
    })
    expect(response.status).toBe(202)
    const row = await latest()
    expect(row).toMatchObject({ outcome: "CREATED", authVerdict: "PASS", senderMembershipId: ws.people.rita.membershipId })
    expect(row.skippedAttachments).toEqual([{ filename: "pretty.svg", reason: "not an allowed type" }])
    ritasTicket = row.ticketId ?? ""
    const ticket = await as("rita").get(`/tickets/${ritasTicket}`)
    expect(ticket.body).toMatchObject({ title: "Printer on floor 3 says offline", source: "EMAIL", requester: { membershipId: ws.people.rita.membershipId } })
    expect(ticket.body.description).toBe("It shows offline from every laptop.")
    const files = await as("rita").get(`/tickets/${ritasTicket}/attachments`)
    expect(files.body.map((f: { filename: string }) => f.filename)).toEqual(["spooler.log"])
  })

  it("lands once, however many times it is delivered", async () => {
    await deliver({ from: ws.people.rita.email, subject: "Printer on floor 3 says offline", text: "again", messageId: "<printer-1@mail.test>" })
    expect(await db.ticket.count({ where: { orgId: ws.orgId } })).toBe(1)
    expect(await db.inboundEmail.count({ where: { orgId: ws.orgId, messageKey: "<printer-1@mail.test>" } })).toBe(1)
  })
})

describe("mail that is not trusted", () => {
  it("records a forged sender, an unknown one and an autoresponder — and raises nothing", async () => {
    const before = await db.ticket.count({ where: { orgId: ws.orgId } })
    const sentBefore = recorder.sent.length
    await deliver({ from: ws.people.rita.email, subject: "Urgent: wire transfer", text: "x", dmarc: "fail" })
    expect(await latest()).toMatchObject({ outcome: "UNAUTHENTICATED", authVerdict: "FAIL", ticketId: null })
    await deliver({ from: ws.people.rita.email, subject: "No verdict", text: "x", dmarc: "none" })
    expect(await latest()).toMatchObject({ outcome: "UNAUTHENTICATED", authVerdict: "NONE" })
    await deliver({ from: "stranger@elsewhere.test", subject: "Hello", text: "x" })
    expect(await latest()).toMatchObject({ outcome: "UNKNOWN_SENDER", authVerdict: "PASS", senderMembershipId: null })
    await deliver({ from: ws.people.rita.email, subject: "Out of office", text: "Back Monday", headers: { "Auto-Submitted": "auto-replied" } })
    expect(await latest()).toMatchObject({ outcome: "AUTO_REPLY" })
    expect(await db.ticket.count({ where: { orgId: ws.orgId } })).toBe(before)
    // No backscatter: nothing is sent to a sender we did not trust.
    expect(recorder.sent.slice(sentBefore)).toEqual([])
  })

  it("does not let forged mail use up a member's allowance", async () => {
    for (let i = 0; i <= SENDER_HOURLY_LIMIT; i += 1) {
      await deliver({ from: ws.people.agent.email, subject: `Forged ${String(i)}`, text: "x", dmarc: "fail" })
    }
    await deliver({ from: ws.people.agent.email, subject: "Switch in room 4 is down", text: "Since 9." })
    expect(await latest()).toMatchObject({ outcome: "CREATED", senderMembershipId: ws.people.agent.membershipId })
  })

  it("refuses a message with two senders, whichever one DMARC judged", async () => {
    await deliver({ from: ws.people.rosa.email, subject: "Two senders", text: "x", headers: { From: ws.people.admin.email } })
    expect(await latest()).toMatchObject({ outcome: "UNAUTHENTICATED", authVerdict: "NONE" })
  })

  it("keeps a subject with a NUL in it in the log, without the NUL", async () => {
    await deliver({ from: "nul@elsewhere.test", subject: "=?utf-8?B?SGVsbG8AV29ybGQ=?=", text: "x", dmarc: "fail" })
    expect(await latest()).toMatchObject({ outcome: "UNAUTHENTICATED", subject: "HelloWorld" })
  })

  it("lets the real message through when a forged copy took its Message-ID first", async () => {
    const messageId = "<guessed-1@mail.test>"
    await deliver({ from: ws.people.rosa.email, subject: "Monitor flickers", text: "forged", dmarc: "fail", messageId })
    expect(await latest()).toMatchObject({ outcome: "UNAUTHENTICATED" })
    await deliver({ from: ws.people.rosa.email, subject: "Monitor flickers", text: "Desk 22 again.", messageId })
    const row = await db.inboundEmail.findUniqueOrThrow({ where: { orgId_messageKey: { orgId: ws.orgId, messageKey: messageId } } })
    expect(row).toMatchObject({ outcome: "CREATED", authVerdict: "PASS", senderMembershipId: ws.people.rosa.membershipId })
  })

  it("holds back one sender's flood past the hourly limit", async () => {
    for (let i = 0; i <= SENDER_HOURLY_LIMIT; i += 1) {
      await deliver({ from: "flood@elsewhere.test", subject: `Message ${String(i)}`, text: "x" })
    }
    expect(await latest()).toMatchObject({ outcome: "RATE_LIMITED", fromAddress: "flood@elsewhere.test" })
  })
})

describe("replies", () => {
  it("thread onto the ticket when they answer our own mail, as a public reply by the member", async () => {
    // The agent's reply reaches Rita by email, with the ticket in its Message-ID.
    const sentBefore = recorder.sent.length
    await as("agent").post(`/tickets/${ritasTicket}/comments`, { body: "Can you restart it?", visibility: "PUBLIC" })
    await jobs.settle()
    const notice = recorder.sent.slice(sentBefore).find((m) => m.to === ws.people.rita.email)
    expect(notice).toMatchObject({ replyTo: address() })
    expect(notice?.subject).toMatch(/\[INC-\d{6}\]/)

    await deliver({
      from: ws.people.rita.email,
      subject: `Re: ${notice?.subject ?? ""}`,
      text: `Restarted, still offline.\n\nOn Wed, Sam wrote:\n> Can you restart it?`,
      inReplyTo: notice?.messageId ?? "",
    })
    expect(await latest()).toMatchObject({ outcome: "THREADED", ticketId: ritasTicket })
    const thread = await as("rita").get(`/tickets/${ritasTicket}/comments`)
    const last = (thread.body as { body: string; visibility: string; author: { membershipId: string } | null }[]).at(-1)
    expect(last).toMatchObject({ body: "Restarted, still offline.", visibility: "PUBLIC", author: { membershipId: ws.people.rita.membershipId } })
  })

  it("from an agent are public replies, never internal notes", async () => {
    const number = (await as("agent").get(`/tickets/${ritasTicket}`)).body.number as string
    await deliver({ from: ws.people.agent.email, subject: `Re: [${number}] Printer`, text: "Replaced the toner." })
    const thread = await as("rita").get(`/tickets/${ritasTicket}/comments`)
    expect((thread.body as { body: string }[]).at(-1)?.body).toBe("Replaced the toner.")
  })

  it("from someone who is not part of the ticket open one of their own beside it", async () => {
    const number = (await as("agent").get(`/tickets/${ritasTicket}`)).body.number as string
    const commentsBefore = await db.comment.count({ where: { orgId: ws.orgId, ticketId: ritasTicket } })
    await deliver({ from: ws.people.rosa.email, subject: `Re: [${number}] Printer`, text: "Me too, on floor 2." })
    const row = await latest()
    expect(row.outcome).toBe("CREATED")
    expect(row.ticketId).not.toBe(ritasTicket)
    expect(await db.comment.count({ where: { orgId: ws.orgId, ticketId: ritasTicket } })).toBe(commentsBefore)
    // Rosa cannot see Rita's ticket; the agent sees the two related.
    expect((await as("rosa").get(`/tickets/${ritasTicket}`)).status).toBe(404)
    // Nothing is attached to Rita's ticket on the sender's behalf: a requester who cannot see it
    // could not link it through the API either, and mail buys no more (M9 review).
    const links = await as("agent").get(`/tickets/${row.ticketId ?? ""}/links`)
    expect(links.body).toEqual([])
  })
})

describe("the inbound sweep", () => {
  it("fails what no worker will finish, and keeps raw mail only as long as retention says", async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000)
    const stuck = await db.inboundEmail.create({
      data: { orgId: ws.orgId, messageKey: "<stuck@mail.test>", fromAddress: "x@y.test", subject: "Stuck", rawStorageKey: `org/${ws.orgId}/inbound/stuck.eml`, receivedAt: old, processedAt: old },
    })
    const ancient = await db.inboundEmail.create({
      data: {
        orgId: ws.orgId,
        messageKey: "<ancient@mail.test>",
        fromAddress: "x@y.test",
        subject: "Ancient",
        outcome: "UNAUTHENTICATED",
        rawStorageKey: `org/${ws.orgId}/inbound/ancient.eml`,
        receivedAt: new Date(Date.now() - 91 * 24 * 60 * 60_000),
      },
    })
    await app.get(StorageService).put(ancient.rawStorageKey, Buffer.from("From: x@y.test\r\n\r\nold"), "message/rfc822")
    const swept = await app.get(InboundSweepProcessor).process({ id: "spec/inbound-sweep", data: { orgId: ws.orgId, tick: 1 } } as unknown as Job)
    expect(swept.failed).toBe(1)
    expect(await db.inboundEmail.findUnique({ where: { id: stuck.id } })).toMatchObject({ outcome: "FAILED", error: "Processing did not finish" })
    // Past both retentions: its bytes go, then its row.
    expect(await app.get(StorageService).size(ancient.rawStorageKey)).toBeNull()
    expect(await db.inboundEmail.findUnique({ where: { id: ancient.id } })).toBeNull()
    // A message that became a ticket keeps its row.
    expect(await db.inboundEmail.count({ where: { orgId: ws.orgId, outcome: "CREATED" } })).toBeGreaterThan(0)
  })
})

describe("the inbound log", () => {
  it("shows an admin what arrived and why it was or was not trusted; nobody else", async () => {
    const log = await as("admin").get("/org/inbound-emails?limit=100")
    const outcomes = (log.body.items as { outcome: string }[]).map((i) => i.outcome)
    expect(outcomes).toEqual(expect.arrayContaining(["CREATED", "THREADED", "UNAUTHENTICATED", "UNKNOWN_SENDER", "AUTO_REPLY"]))
    const rejected = await as("admin").get("/org/inbound-emails?outcome=UNKNOWN_SENDER&limit=100")
    expect((rejected.body.items as { outcome: string }[]).every((i) => i.outcome === "UNKNOWN_SENDER")).toBe(true)
    expect(rejected.body.items).toContainEqual(expect.objectContaining({ fromAddress: "stranger@elsewhere.test", sender: null, ticket: null }))
    expect((await as("agent").get("/org/inbound-emails")).status).toBe(403)
  })
})
