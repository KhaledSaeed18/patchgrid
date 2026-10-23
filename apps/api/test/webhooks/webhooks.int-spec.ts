/**
 * Outbound webhooks end to end (ADR-0050), against a receiver on this machine:
 * a change commits, the `webhooks` consumer writes a delivery, the attempt
 * signs and sends it. The app runs as `api`, so no worker races the spec; the
 * spec drains the log and makes each attempt by hand, inside the tenant, and
 * moves time by moving `nextAttemptAt` rather than waiting for it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import process from "node:process"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventRelay } from "../../src/events/relay"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MailService } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { WebhookDeliverer } from "../../src/webhooks/delivery/deliverer"
import { TenantLease } from "../../src/webhooks/delivery/tenant-lease"
import { CIRCUIT_THRESHOLD, MAX_ATTEMPTS } from "../../src/webhooks/domain/schedule"
import { verify } from "../../src/webhooks/domain/signature"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Received = { headers: IncomingHttpHeaders; body: string }

let owner: PrismaClient
let app: INestApplication
let ws: Workspace<"owner" | "agent" | "requester">
let receiver: Server
let hookUrl = ""
let respondWith = 200
const received: Received[] = []
/** When set, the receiver holds its answer until released: an attempt kept in flight on purpose. */
let hold: Promise<void> | null = null
/** Resolves when the next request arrives. */
let arrived: (() => void) | null = null

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  // The receiver is on this machine: the spec lifts the private-address refusal for itself.
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true"
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  receiver = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => (body += chunk.toString()))
    req.on("end", () => {
      received.push({ headers: req.headers, body })
      arrived?.()
      const answer = () => res.writeHead(respondWith).end(respondWith === 200 ? "ok" : "receiver is down")
      if (hold === null) answer()
      else void hold.then(answer)
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve))
  hookUrl = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}/hook`

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, owner, { prefix: "hook", people: { owner: "OWNER", agent: "AGENT", requester: "REQUESTER" } })
})

beforeEach(() => {
  received.length = 0
  respondWith = 200
})

afterAll(async () => {
  await owner.webhookDelivery.deleteMany({ where: { orgId: ws.orgId } })
  await owner.webhookEndpoint.deleteMany({ where: { orgId: ws.orgId } })
  await owner.notification.deleteMany({ where: { orgId: ws.orgId } })
  await owner.comment.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await new Promise<void>((resolve) => receiver.close(() => resolve()))
  await owner.$disconnect()
  delete process.env.WORKER_MODE
  delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS
})

const as = (who: "owner" | "agent" | "requester") => browser(app, ws.origin, ws.people[who].access)
const crossing = { actor: "webhooks-spec", reason: "drive deliveries by hand" }

/** The `webhooks` consumer reads everything committed so far. */
async function drainLog(): Promise<void> {
  for (;;) {
    const outcome = await runAsTenant(ws.orgId, crossing, () => app.get(EventRelay).drain(ws.orgId, "webhooks"))
    if (outcome.kind === "idle" && !outcome.heldBack) return
  }
}

/** One attempt at a delivery, now: its `nextAttemptAt` is moved to the past first, standing in for the wait. */
async function attempt(deliveryId: string) {
  await owner.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "PENDING" },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  })
  return runAsTenant(ws.orgId, crossing, () => app.get(WebhookDeliverer).attempt(ws.orgId, deliveryId))
}

async function newTicket(title: string): Promise<string> {
  const created = await as("requester").post("/tickets", {
    type: "INCIDENT",
    title,
    description: "Secret details",
    impact: "LOW",
    urgency: "LOW",
  })
  expect(created.status).toBe(201)
  return created.body.id as string
}

async function endpoint(eventTypes: string[]): Promise<{ id: string; secret: string }> {
  const created = await as("owner").post("/org/webhooks", { url: hookUrl, eventTypes })
  expect(created.status).toBe(201)
  return { id: created.body.endpoint.id as string, secret: created.body.secret as string }
}

const deliveriesOf = (endpointId: string) => owner.webhookDelivery.findMany({ where: { endpointId }, orderBy: { createdAt: "asc" } })

describe("managing endpoints", () => {
  it("is an admin's: an agent is refused, and the secret is shown once", async () => {
    expect((await as("agent").get("/org/webhooks")).status).toBe(403)
    expect((await as("agent").post("/org/webhooks", { url: hookUrl, eventTypes: ["ticket.created"] })).status).toBe(403)
    const created = await endpoint(["ticket.created"])
    expect(created.secret).toMatch(/^whsec_/)
    const listed = await as("owner").get("/org/webhooks")
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).not.toContain(created.secret)
    // At rest it is sealed, not the secret itself.
    const row = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.secretSealed).not.toContain(created.secret.slice(6))
    await as("owner").delete(`/org/webhooks/${created.id}`)
    const audited = await owner.auditLog.findMany({ where: { orgId: ws.orgId, action: { in: ["WEBHOOK_CREATED", "WEBHOOK_DELETED"] } } })
    expect(audited.length).toBeGreaterThanOrEqual(2)
    // The path can be a credential (a chat hook's key): the audit log keeps the origin and a fingerprint.
    expect(JSON.stringify(audited)).not.toContain("/hook")
    expect(JSON.stringify(audited)).toContain("127.0.0.1")
  })

  it("refuses a URL with credentials, and an event type the catalogue does not have", async () => {
    expect(
      (await as("owner").post("/org/webhooks", { url: "https://u:p@hooks.example.com/", eventTypes: ["ticket.created"] })).status,
    ).toBe(400)
    expect((await as("owner").post("/org/webhooks", { url: hookUrl, eventTypes: ["comment.internal"] })).status).toBe(400)
  })
})

describe("a delivery", () => {
  it("is signed, thin, and identified by the id a receiver deduplicates on", async () => {
    const hook = await endpoint(["ticket.created"])
    const ticketId = await newTicket("Printer on fire")
    await drainLog()
    const [delivery] = await deliveriesOf(hook.id)
    if (delivery === undefined) throw new Error("no delivery was written")
    expect(await attempt(delivery.id)).toEqual({ kind: "delivered" })

    expect(received).toHaveLength(1)
    const [request] = received
    if (request === undefined) throw new Error("nothing arrived")
    const headers = {
      id: String(request.headers["webhook-id"]),
      timestamp: String(request.headers["webhook-timestamp"]),
      signature: String(request.headers["webhook-signature"]),
    }
    expect(headers.id).toBe(delivery.id)
    expect(verify(hook.secret, headers, request.body, Math.floor(Date.now() / 1000))).toBe(true)
    const payload = JSON.parse(request.body) as { id: string; type: string; data: { ticket: { id: string; number: string } } }
    expect(payload).toMatchObject({ id: delivery.id, type: "ticket.created", data: { ticket: { id: ticketId } } })
    expect(payload.data.ticket.number).toMatch(/^INC-\d{6}$/)
    // Thin: identifiers and states, never the ticket's words.
    expect(request.body).not.toContain("Printer on fire")
    expect(request.body).not.toContain("Secret details")
    expect(await owner.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      lastStatusCode: 200,
    })

    // A second drain of the same log writes nothing twice, and a second attempt sends nothing twice.
    await drainLog()
    expect(await deliveriesOf(hook.id)).toHaveLength(1)
    expect(await attempt(delivery.id)).toEqual({ kind: "skipped" })
    expect(received).toHaveLength(1)
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })

  it("goes only to endpoints that listen for its type, and an internal note to none", async () => {
    const created = await endpoint(["ticket.created"])
    const comments = await endpoint(["comment.created"])
    const ticketId = await newTicket("Scanner jams")
    const ticket = await as("agent").get(`/tickets/${ticketId}`)
    expect((await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Internal only", visibility: "INTERNAL" })).status).toBe(201)
    expect((await as("agent").post(`/tickets/${ticketId}/comments`, { body: "We are on it", visibility: "PUBLIC" })).status).toBe(201)
    expect(ticket.status).toBe(200)
    await drainLog()
    expect((await deliveriesOf(created.id)).map((d) => d.eventType)).toEqual(["ticket.created"])
    // Two comments, one delivery: the internal note is not in the catalogue.
    expect((await deliveriesOf(comments.id)).map((d) => d.eventType)).toEqual(["comment.created"])
    await as("owner").delete(`/org/webhooks/${created.id}`)
    await as("owner").delete(`/org/webhooks/${comments.id}`)
  })
})

describe("failure", () => {
  it("retries with growing waits, gives up after the last attempt, and replays from the start", async () => {
    const hook = await endpoint(["ticket.created"])
    await newTicket("Disk full")
    await drainLog()
    const [delivery] = await deliveriesOf(hook.id)
    if (delivery === undefined) throw new Error("no delivery was written")
    respondWith = 500

    const first = await attempt(delivery.id)
    expect(first).toMatchObject({ kind: "retry", attempt: 1 })
    const pending = await owner.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1, lastStatusCode: 500 })
    expect(pending.lastError).toContain("HTTP 500")

    // Straight to the last attempt; a failure there is the end.
    await owner.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts: MAX_ATTEMPTS - 1 } })
    expect(await attempt(delivery.id)).toEqual({ kind: "dead" })
    expect(await owner.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({
      status: "DEAD",
      nextAttemptAt: null,
    })

    // An endpoint that is off is turned on before its deliveries are replayed.
    await as("owner").patch(`/org/webhooks/${hook.id}`, { enabled: false })
    expect((await as("owner").post(`/org/webhooks/${hook.id}/deliveries/replay`)).status).toBe(409)
    await as("owner").patch(`/org/webhooks/${hook.id}`, { enabled: true })

    // A delivery still trying cannot be replayed; a dead one can, from attempt zero.
    respondWith = 200
    const replayed = await as("owner").post(`/org/webhooks/${hook.id}/deliveries/${delivery.id}/replay`)
    expect(replayed.status).toBe(200)
    expect(replayed.body).toEqual({ replayed: 1 })
    expect(await owner.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: "PENDING", attempts: 0 })
    expect(await attempt(delivery.id)).toEqual({ kind: "delivered" })
    expect((await as("owner").post(`/org/webhooks/${hook.id}/deliveries/${delivery.id}/replay`)).status).toBe(409)

    const log = await as("owner").get(`/org/webhooks/${hook.id}/deliveries`)
    expect(log.body.items[0]).toMatchObject({ id: delivery.id, status: "SUCCEEDED", attempts: 1 })
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })

  it("opens the endpoint's circuit after repeated failures, and waits instead of spending attempts", async () => {
    const hook = await endpoint(["ticket.created"])
    respondWith = 500
    for (let i = 0; i < CIRCUIT_THRESHOLD; i += 1) await newTicket(`Outage ${String(i)}`)
    await drainLog()
    const deliveries = await deliveriesOf(hook.id)
    expect(deliveries).toHaveLength(CIRCUIT_THRESHOLD)
    for (const d of deliveries) await attempt(d.id)
    const opened = await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })
    expect(opened.consecutiveFailures).toBe(CIRCUIT_THRESHOLD)
    expect(opened.circuitOpenUntil?.getTime()).toBeGreaterThan(Date.now())

    const sent = received.length
    const [next] = deliveries
    if (next === undefined) throw new Error("no delivery")
    const postponed = await attempt(next.id)
    expect(postponed).toMatchObject({ kind: "postponed" })
    expect(received).toHaveLength(sent)
    expect((await owner.webhookDelivery.findUniqueOrThrow({ where: { id: next.id } })).attempts).toBe(1)

    // Once its time has come, one attempt is the probe and the others wait for its answer.
    await owner.webhookEndpoint.update({ where: { id: hook.id }, data: { circuitOpenUntil: new Date(Date.now() - 1_000) } })
    respondWith = 200
    const [first, second] = deliveries
    if (first === undefined || second === undefined) throw new Error("no deliveries")
    await owner.webhookDelivery.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    })
    // The probe is held in flight at the receiver, so the second attempt runs while it is out.
    let release = () => undefined as void
    hold = new Promise<void>((resolve) => (release = resolve))
    const reached = new Promise<void>((resolve) => (arrived = resolve))
    // Straight to the deliverer: the circuit, not the spec's helper, decides when each goes.
    const tryNow = (id: string) => runAsTenant(ws.orgId, crossing, () => app.get(WebhookDeliverer).attempt(ws.orgId, id))
    const probe = tryNow(first.id)
    await reached
    expect(await tryNow(second.id)).toMatchObject({ kind: "postponed" })
    release()
    hold = null
    arrived = null
    expect(await probe).toEqual({ kind: "delivered" })
    // The probe's success closes the circuit.
    expect(await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({
      consecutiveFailures: 0,
      circuitOpenUntil: null,
    })

    // Turning it back on closes the circuit.
    await as("owner").patch(`/org/webhooks/${hook.id}`, { enabled: false })
    const back = await as("owner").patch(`/org/webhooks/${hook.id}`, { enabled: true })
    expect(back.body).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0, circuitOpenUntil: null })
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })
})

describe("five days without a success", () => {
  it("turns the endpoint off and tells the workspace's admins and owners, in the same transaction", async () => {
    const hook = await endpoint(["ticket.created"])
    await owner.webhookEndpoint.update({
      where: { id: hook.id },
      data: { failingSince: new Date(Date.now() - 6 * 24 * 60 * 60_000), consecutiveFailures: 1 },
    })
    respondWith = 500
    await newTicket("Still down")
    await drainLog()
    const [delivery] = await deliveriesOf(hook.id)
    if (delivery === undefined) throw new Error("no delivery")
    const mail = app.get(MailService)
    const queued: { kind: string; to: string; settingsUrl: string }[] = []
    const spy = vi.spyOn(mail, "enqueueAll").mockImplementation(async (mails) => {
      for (const { job } of mails)
        if (job.kind === "webhook-disabled") queued.push({ kind: job.kind, to: job.to, settingsUrl: job.params.settingsUrl })
    })
    await attempt(delivery.id)
    spy.mockRestore()
    expect(await owner.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({ status: "DISABLED" })
    // The owner manages webhooks; the agent and the requester do not hear of it.
    expect(queued).toEqual([
      { kind: "webhook-disabled", to: ws.people.owner.email, settingsUrl: expect.stringContaining(`/settings/webhooks/${hook.id}`) },
    ])
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })
})

describe("a new endpoint", () => {
  it("hears only of what happened after it existed, however far behind the consumer is", async () => {
    await newTicket("Before the endpoint")
    const hook = await endpoint(["ticket.created"])
    await newTicket("After the endpoint")
    await drainLog()
    expect(await deliveriesOf(hook.id)).toHaveLength(1)
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })
})

describe("rotation", () => {
  it("signs with the new secret and the old one until the old one lapses", async () => {
    const hook = await endpoint(["ticket.created"])
    const rotated = await as("owner").post(`/org/webhooks/${hook.id}/rotate-secret`)
    expect(rotated.status).toBe(200)
    const fresh = rotated.body.secret as string
    expect(fresh).not.toBe(hook.secret)
    await newTicket("Rotate me")
    await drainLog()
    const [delivery] = await deliveriesOf(hook.id)
    if (delivery === undefined) throw new Error("no delivery")
    await attempt(delivery.id)
    const [request] = received
    if (request === undefined) throw new Error("nothing arrived")
    const headers = {
      id: String(request.headers["webhook-id"]),
      timestamp: String(request.headers["webhook-timestamp"]),
      signature: String(request.headers["webhook-signature"]),
    }
    expect(headers.signature.split(" ")).toHaveLength(2)
    const now = Math.floor(Date.now() / 1000)
    expect(verify(fresh, headers, request.body, now)).toBe(true)
    expect(verify(hook.secret, headers, request.body, now)).toBe(true)
    // A second rotation inside the overlap would cut off receivers still on the first secret.
    expect((await as("owner").post(`/org/webhooks/${hook.id}/rotate-secret`)).status).toBe(409)
    await as("owner").delete(`/org/webhooks/${hook.id}`)
  })
})

describe("the in-flight cap", () => {
  it("lets a tenant hold at most its cap of leases, and frees a slot on release or expiry", async () => {
    const lease = app.get(TenantLease)
    const org = ws.orgId
    const a = await lease.acquire(org, 2, 30_000)
    const b = await lease.acquire(org, 2, 30_000)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(await lease.acquire(org, 2, 30_000)).toBeNull()
    await a?.release()
    const c = await lease.acquire(org, 2, 30_000)
    expect(c).not.toBeNull()
    // A lease past its life no longer counts: a worker that died frees its slot.
    expect(await lease.acquire(org, 2, 30_000, Date.now() + 31_000)).not.toBeNull()
    await b?.release()
    await c?.release()
  })
})
