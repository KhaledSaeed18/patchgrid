/**
 * Event retention against Postgres (ADR-0049): what the daily sweep may delete
 * from the outbox, and what it must leave. Never an event ahead of any
 * consumer's cursor, never one a delivery or a dead letter points at, never
 * one inside the window.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { RetentionRepository } from "../../src/jobs/maintenance/repositories/retention.repository"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { PrismaService } from "../../src/prisma/prisma.service"

let owner: PrismaClient
let app: INestApplication
let orgId = ""

const DAY = 24 * 3_600_000
const old = new Date(Date.now() - 40 * DAY)
const window = new Date(Date.now() - 30 * DAY)

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication({ logger: false })
  await app.init()
  const suffix = randomUUID().slice(0, 8)
  orgId = (await owner.organization.create({ data: { name: `Retention ${suffix}`, slug: `retention-${suffix}` } })).id
})

afterAll(async () => {
  await owner.eventDeadLetter.deleteMany({ where: { orgId } })
  await owner.eventConsumer.deleteMany({ where: { orgId } })
  await owner.outboxEvent.deleteMany({ where: { orgId } })
  await owner.organization.deleteMany({ where: { id: orgId } })
  await app?.close()
  await owner.$disconnect()
  delete process.env.WORKER_MODE
})

/** One event per transaction, so each has its own place in the log. */
async function event(n: number, occurredAt: Date) {
  return owner.outboxEvent.create({ data: { orgId, type: "retention-spec", payload: { n }, occurredAt } })
}

const sweep = (consumers: string[]) =>
  runAsTenant(orgId, { actor: "retention-spec", reason: "trim the log" }, () =>
    app.get(PrismaService).transaction(() => app.get(RetentionRepository).deleteConsumedEventsBefore(orgId, window, consumers, 100)),
  )

const left = async () => (await owner.outboxEvent.findMany({ where: { orgId }, orderBy: [{ txn: "asc" }, { id: "asc" }] })).map((e) => (e.payload as { n: number }).n)

describe("event retention", () => {
  it("deletes only old events every consumer has read and nothing points at", async () => {
    const e1 = await event(1, old)
    const e2 = await event(2, old)
    const e3 = await event(3, old)
    const e4 = await event(4, old)
    const e5 = await event(5, new Date())

    // notify has read everything; webhooks only up to e2.
    await owner.eventConsumer.createMany({
      data: [
        { orgId, consumer: "notify", cursorTxn: e5.txn, cursorEventId: e5.id },
        { orgId, consumer: "webhooks", cursorTxn: e2.txn, cursorEventId: e2.id },
      ],
    })
    // e1 is parked: a dead letter points at it.
    await owner.eventDeadLetter.create({ data: { orgId, consumer: "webhooks", eventId: e1.id, failures: 3, error: "parked" } })

    expect(await sweep(["notify", "webhooks"])).toBe(1)
    // e1: a dead letter points at it. e2: gone. e3, e4: webhooks has not read them. e5: inside the window.
    expect(await left()).toEqual([1, 3, 4, 5])

    // Once webhooks catches up, e3 and e4 go too; e5 is still too young.
    await owner.eventConsumer.update({ where: { orgId_consumer: { orgId, consumer: "webhooks" } }, data: { cursorTxn: e4.txn, cursorEventId: e4.id } })
    expect(await sweep(["notify", "webhooks"])).toBe(2)
    expect(await left()).toEqual([1, 5])
    expect(e3.occurredAt).toEqual(old)
  })

  it("holds everything back for a consumer that has never run", async () => {
    const e6 = await event(6, old)
    // Both running consumers have read e6; a third, new one has read nothing.
    await owner.eventConsumer.updateMany({ where: { orgId }, data: { cursorTxn: e6.txn, cursorEventId: e6.id } })
    expect(await sweep(["notify", "webhooks", "reporting"])).toBe(0)
    expect(await left()).toContain(6)
    expect(await sweep(["notify", "webhooks"])).toBe(1)
    expect(await left()).not.toContain(6)
  })
})
