/**
 * The relay against a real Postgres (ADR-0049): each claim the ADR makes, made
 * to fail the way it would fail without the mechanism that prevents it. The
 * app runs with `WORKER_MODE=api`, so no worker races the spec for the log;
 * the spec drains by hand, inside the tenant, as the drain job would.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventConsumers, type EventConsumer } from "../../src/events/consumer"
import { Outbox } from "../../src/events/outbox"
import { ConsumerEventFailed, type DrainOutcome, EventRelay, OUTBOX_MAX_FAILURES } from "../../src/events/relay"
import type { StoredEvent } from "../../src/events/repositories/outbox.repository"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { PrismaService } from "../../src/prisma/prisma.service"

let owner: PrismaClient
let app: INestApplication
let consumer: EventConsumer
const orgIds: string[] = []

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  consumer = app.get(EventConsumers).get("notify")
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  await owner.eventDeadLetter.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.eventConsumer.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.outboxEvent.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.organization.deleteMany({ where: { id: { in: orgIds } } })
  await app?.close()
  await owner.$disconnect()
  delete process.env.WORKER_MODE
})

async function org(): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const created = await owner.organization.create({ data: { name: `Outbox ${suffix}`, slug: `outbox-${suffix}` } })
  orgIds.push(created.id)
  return created.id
}

/** Events no consumer acts on, so the spec watches the relay and nothing else. */
const event = (orgId: string, n: number) => ({ orgId, type: "relay-spec", payload: { n } })

const crossing = { actor: "relay-spec", reason: "drive the relay by hand" }
const drain = (orgId: string, batch?: number): Promise<DrainOutcome> =>
  runAsTenant(orgId, crossing, () => app.get(EventRelay).drain(orgId, "notify", batch))

/** Stands in for the backoff passing: the failure is made older than any wait. */
const waitOut = (orgId: string) =>
  owner.$executeRaw`UPDATE "EventConsumer" SET "updatedAt" = now() - interval '1 hour' WHERE "orgId" = ${orgId}::uuid`

/** Records what the consumer was handed, batch by batch; `fail` makes chosen events throw. */
function watch(fail: (e: StoredEvent) => boolean = () => false) {
  const batches: number[][] = []
  vi.spyOn(consumer, "handle").mockImplementation(async (_orgId, events) => {
    const bad = events.find(fail)
    if (bad !== undefined) throw new Error(`poisoned ${String((bad.payload as { n: number }).n)}`)
    batches.push(events.map((e) => (e.payload as { n: number }).n))
    return async () => undefined
  })
  return batches
}

describe("the outbox is written with the change", () => {
  it("an event appended in a transaction that rolls back is never there", async () => {
    const orgId = await org()
    const outbox = app.get(Outbox)
    await expect(
      runAsTenant(orgId, crossing, () =>
        app.get(PrismaService).transaction(async () => {
          await outbox.append(orgId, [{ type: "relay-spec", payload: { n: 1 } }])
          throw new Error("the change failed")
        }),
      ),
    ).rejects.toThrow("the change failed")
    expect(await owner.outboxEvent.count({ where: { orgId } })).toBe(0)
  })

  it("refuses an append outside a transaction, or for another tenant", async () => {
    const orgId = await org()
    const other = await org()
    const outbox = app.get(Outbox)
    await expect(runAsTenant(orgId, crossing, () => outbox.append(orgId, [{ type: "relay-spec", payload: {} }]))).rejects.toThrow(
      /inside the transaction/,
    )
    await expect(
      runAsTenant(orgId, crossing, () =>
        app.get(PrismaService).transaction(() => outbox.append(other, [{ type: "relay-spec", payload: {} }])),
      ),
    ).rejects.toThrow(/inside the transaction/)
  })
})

describe("the horizon", () => {
  it("never moves past an event whose transaction commits after a later one", async () => {
    const orgId = await org()
    const batches = watch()
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    let inserted = () => undefined as void
    const insertedA = new Promise<void>((resolve) => (inserted = resolve))

    // A takes its transaction id first and stays open; B commits after it.
    const a = owner.$transaction(
      async (tx) => {
        await tx.outboxEvent.create({ data: event(orgId, 1) })
        inserted()
        await held
      },
      { timeout: 20_000 },
    )
    await insertedA
    await owner.outboxEvent.create({ data: event(orgId, 2) })

    // B is committed and visible, but A could still appear before it: B waits.
    expect(await drain(orgId)).toEqual({ kind: "idle", heldBack: true })
    expect(batches).toEqual([])

    release()
    await a
    expect(await drain(orgId)).toMatchObject({ kind: "drained", count: 2 })
    expect(batches).toEqual([[1, 2]])
  })
})

describe("draining", () => {
  it("reads in batches, yields when a batch is full, and never hands an event twice", async () => {
    const orgId = await org()
    const batches = watch()
    await owner.outboxEvent.createMany({ data: [1, 2, 3, 4, 5].map((n) => event(orgId, n)) })
    expect(await drain(orgId, 2)).toEqual({ kind: "drained", count: 2, parked: 0, more: true })
    expect(await drain(orgId, 2)).toEqual({ kind: "drained", count: 2, parked: 0, more: true })
    expect(await drain(orgId, 2)).toEqual({ kind: "drained", count: 1, parked: 0, more: false })
    expect(await drain(orgId, 2)).toEqual({ kind: "idle", heldBack: false })
    expect(batches).toEqual([[1, 2], [3, 4], [5]])
  })

  it("lets one drain at a time read a consumer's place; the other is told it is busy", async () => {
    const orgId = await org()
    await owner.outboxEvent.create({ data: event(orgId, 1) })
    let release = () => undefined as void
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered = () => undefined as void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    vi.spyOn(consumer, "handle").mockImplementation(async () => {
      entered()
      await held
      return async () => undefined
    })
    const first = drain(orgId)
    await inside
    expect(await drain(orgId)).toEqual({ kind: "busy" })
    release()
    expect(await first).toMatchObject({ kind: "drained", count: 1 })
  })

  it("keeps each tenant's place apart", async () => {
    const acme = await org()
    const globex = await org()
    const batches = watch()
    await owner.outboxEvent.createMany({ data: [event(acme, 1), event(globex, 100)] })
    await drain(acme)
    expect(batches).toEqual([[1]])
    await drain(globex)
    expect(batches).toEqual([[1], [100]])
  })
})

describe("poison events", () => {
  it("narrows a failing batch to the event, counts its failures, then parks it and moves on", async () => {
    const orgId = await org()
    const batches = watch((e) => (e.payload as { n: number }).n === 2)
    await owner.outboxEvent.createMany({ data: [1, 2, 3].map((n) => event(orgId, n)) })

    // The batch fails; event 1 is handled on its own, and event 2 is the one to blame.
    await expect(drain(orgId)).rejects.toBeInstanceOf(ConsumerEventFailed)
    expect(batches).toEqual([[1]])
    const poisoned = await owner.outboxEvent.findFirstOrThrow({ where: { orgId, payload: { equals: { n: 2 } } } })
    expect(await owner.eventConsumer.findFirstOrThrow({ where: { orgId } })).toMatchObject({ failingEventId: poisoned.id, failures: 1 })

    // A drain that comes straight back, from a wake or the sweep, waits out the backoff and blames nothing.
    expect(await drain(orgId)).toMatchObject({ kind: "backoff" })
    expect(await owner.eventConsumer.findFirstOrThrow({ where: { orgId } })).toMatchObject({ failures: 1 })
    for (let attempt = 2; attempt <= OUTBOX_MAX_FAILURES; attempt += 1) {
      await waitOut(orgId)
      await expect(drain(orgId)).rejects.toBeInstanceOf(ConsumerEventFailed)
    }
    expect(await owner.eventConsumer.findFirstOrThrow({ where: { orgId } })).toMatchObject({ failures: OUTBOX_MAX_FAILURES })

    // Given up on: parked with its error, and the stream goes on without it.
    await waitOut(orgId)
    expect(await drain(orgId)).toMatchObject({ kind: "drained", parked: 1 })
    expect(await owner.eventDeadLetter.findFirstOrThrow({ where: { orgId } })).toMatchObject({
      consumer: "notify",
      eventId: poisoned.id,
      failures: OUTBOX_MAX_FAILURES,
    })
    expect(await drain(orgId)).toMatchObject({ kind: "drained", count: 1 })
    expect(batches).toEqual([[1], [3]])
    expect(await owner.eventConsumer.findFirstOrThrow({ where: { orgId } })).toMatchObject({ failingEventId: null, failures: 0 })
  })

  it("forgets the count when the event that failed later succeeds", async () => {
    const orgId = await org()
    let broken = true
    const batches = watch(() => broken)
    await owner.outboxEvent.create({ data: event(orgId, 1) })
    await expect(drain(orgId)).rejects.toBeInstanceOf(ConsumerEventFailed)
    broken = false
    await waitOut(orgId)
    expect(await drain(orgId)).toMatchObject({ kind: "drained", count: 1, parked: 0 })
    expect(batches).toEqual([[1]])
    expect(await owner.eventDeadLetter.count({ where: { orgId } })).toBe(0)
  })

  it("never blames an event for the database's trouble: a deadlock is retried as the job's, uncounted", async () => {
    const orgId = await org()
    await owner.outboxEvent.create({ data: event(orgId, 1) })
    vi.spyOn(consumer, "handle").mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" }))
    await expect(drain(orgId)).rejects.toThrow("deadlock detected")
    expect(await owner.eventConsumer.findFirst({ where: { orgId } })).toBeNull()
    watch()
    expect(await drain(orgId)).toMatchObject({ kind: "drained", count: 1 })
  })
})
