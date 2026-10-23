/**
 * The relay with real workers (ADR-0049): what M11's exit asks of it.
 *
 * - A change committed while no worker runs is delivered when one starts,
 *   once, without waiting for the sweep's tick.
 * - A commit wakes a running worker by itself: no spec pokes the log.
 * - A tenant flooding its log does not hold another tenant's events behind it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventConsumers } from "../../src/events/consumer"
import { OUTBOX_DRAIN_QUEUE } from "../../src/events/drain-requests"
import { DRAIN_BATCH } from "../../src/events/relay"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let owner: PrismaClient
let api: INestApplication
let worker: INestApplication | undefined
let ws: Workspace<"requester" | "agent" | "assignee">
let jobs: Settler | undefined
const orgIds: string[] = []

async function boot(mode: "api" | "all"): Promise<INestApplication> {
  process.env.WORKER_MODE = mode
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  const app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  return app
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  // The API alone: requests commit, nothing drains.
  api = await boot("api")
  ws = await seedWorkspace(api, owner, { prefix: "relay", people: { requester: "REQUESTER", agent: "AGENT", assignee: "AGENT" } })
})

afterAll(async () => {
  await owner.notification.deleteMany({ where: { orgId: ws.orgId } })
  await owner.comment.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await owner.eventConsumer.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.outboxEvent.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.organization.deleteMany({ where: { id: { in: orgIds } } })
  await jobs?.close()
  await worker?.close()
  await api?.close()
  await owner.$disconnect()
  delete process.env.WORKER_MODE
})

const assignedTo = (membershipId: string) => owner.notification.count({ where: { orgId: ws.orgId, membershipId, type: "TICKET_ASSIGNED" } })

describe("a change committed while no worker runs", () => {
  it("is delivered when a worker starts, exactly once, without waiting for the sweep's tick", async () => {
    const as = (who: "requester" | "agent") => browser(api, ws.origin, ws.people[who].access)
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Printer on fire",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    expect(created.status).toBe(201)
    const assigned = await as("agent").put(`/tickets/${String(created.body.id)}/assignment`, {
      version: created.body.version,
      assigneeMembershipId: ws.people.assignee.membershipId,
    })
    expect(assigned.status).toBe(200)

    // Committed and recorded, but nobody is reading the log.
    expect(await owner.outboxEvent.count({ where: { orgId: ws.orgId, type: "ticket-assigned" } })).toBe(1)
    expect(await assignedTo(ws.people.assignee.membershipId)).toBe(0)

    // A worker starts. Its boot catches up on what committed while nobody listened.
    worker = await boot("all")
    // The sweep and drain queues only: the dispatcher's own queue holds its schedules, which never settle.
    jobs = settler(worker, ["outbox-sweep", OUTBOX_DRAIN_QUEUE], { followOutbox: false })
    await jobs.settle()
    expect(await assignedTo(ws.people.assignee.membershipId)).toBe(1)

    // Another sweep finds nothing to do: the rows were written with the cursor that passed them.
    await jobs.settle()
    expect(await assignedTo(ws.people.assignee.membershipId)).toBe(1)
  })
})

describe("with a worker running", () => {
  async function org(): Promise<string> {
    const suffix = randomUUID().slice(0, 8)
    const created = await owner.organization.create({ data: { name: `Relay ${suffix}`, slug: `relay-${suffix}` } })
    orgIds.push(created.id)
    return created.id
  }

  /** Waits, through the queues, until the consumer's cursor in `orgId` has passed its last event. */
  async function untilConsumed(orgId: string): Promise<void> {
    const last = await owner.outboxEvent.findMany({ where: { orgId }, orderBy: [{ txn: "desc" }, { id: "desc" }], take: 1 })
    expect(last).toHaveLength(1)
    for (;;) {
      await jobs?.settle()
      const cursor = await owner.eventConsumer.findUnique({ where: { orgId_consumer: { orgId, consumer: "notify" } } })
      if (cursor !== null && cursor.cursorEventId === last[0]?.id) return
    }
  }

  it("a commit wakes the worker by itself", async () => {
    if (worker === undefined) throw new Error("the first spec starts the worker")
    const orgId = await org()
    await owner.outboxEvent.create({ data: { orgId, type: "relay-spec", payload: { n: 1 } } })
    await untilConsumed(orgId)
  })

  it("a tenant's flood does not hold another tenant's event behind it", async () => {
    if (worker === undefined) throw new Error("the first spec starts the worker")
    const consumer = worker.get(EventConsumers).get("notify")
    const order: string[] = []
    const handle = consumer.handle.bind(consumer)
    vi.spyOn(consumer, "handle").mockImplementation(async (orgId, events) => {
      order.push(orgId)
      return handle(orgId, events)
    })
    const flood = await org()
    const quiet = await org()
    const batches = 5
    await owner.outboxEvent.createMany({
      data: Array.from({ length: batches * DRAIN_BATCH }, (_, n) => ({ orgId: flood, type: "relay-spec", payload: { n } })),
    })
    await owner.outboxEvent.create({ data: { orgId: quiet, type: "relay-spec", payload: { n: 0 } } })
    await untilConsumed(flood)
    await untilConsumed(quiet)

    const floodBatches = order.filter((o) => o === flood).length
    expect(floodBatches).toBe(batches)
    // The quiet tenant's one event was read before the flood's last batch: it waited for a batch, not a flood.
    expect(order.indexOf(quiet)).toBeLessThan(order.lastIndexOf(flood))
  })
})
