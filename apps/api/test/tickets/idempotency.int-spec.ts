/**
 * `Idempotency-Key` through the booted app (ADR-0012): a retried create
 * replays the first answer instead of making a second ticket; the same key
 * with another body is a conflict; a request without a key is untouched; and
 * one person's key never replays to another.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"alice" | "bob">

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "idem", people: { alice: "REQUESTER", bob: "REQUESTER" } })
})

afterAll(async () => {
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await db.usageCounter.deleteMany({ where: { orgId: ws.orgId, metric: "TICKETS_CREATED" } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const ticket = { type: "INCIDENT", title: "Printer jam", description: "Floor 2", impact: "LOW", urgency: "LOW" }
const post = (who: "alice" | "bob", key: string | null, body: object = ticket) => {
  const req = browser(app, ws.origin, ws.people[who].access).post("/tickets", body)
  return key === null ? req : req.set("Idempotency-Key", key)
}

describe("Idempotency-Key", () => {
  it("replays a retried create instead of making a second ticket", async () => {
    const key = randomUUID()
    const first = await post("alice", key)
    const retry = await post("alice", key)
    expect(first.status).toBe(201)
    expect(retry.status).toBe(201)
    expect(retry.headers["idempotent-replayed"]).toBe("true")
    expect(retry.body.id).toBe(first.body.id)
    expect(await db.ticket.count({ where: { orgId: ws.orgId } })).toBe(1)
  })

  it("refuses the same key with a different body", async () => {
    const key = randomUUID()
    expect((await post("alice", key)).status).toBe(201)
    const other = await post("alice", key, { ...ticket, title: "Something else" })
    expect(other.status).toBe(409)
  })

  it("never replays one person's key to another", async () => {
    const key = randomUUID()
    const alice = await post("alice", key)
    const bob = await post("bob", key)
    expect(bob.status).toBe(201)
    expect(bob.body.id).not.toBe(alice.body.id)
  })

  it("leaves a request without a key alone, and refuses a malformed key", async () => {
    const [a, b] = [await post("alice", null), await post("alice", null)]
    expect(a.body.id).not.toBe(b.body.id)
    expect((await post("alice", "x")).status).toBe(400)
  })
})
