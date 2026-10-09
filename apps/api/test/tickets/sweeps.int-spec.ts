/**
 * The per-tenant sweeps against a real database (DOMAIN.md §2.1, §4.3): the
 * SLA scan warns, then breaches, each once and audited; auto-close closes a
 * ticket resolved for seven days, as the system. Driven through the sweep
 * processors with an injected clock, exactly as the dispatcher's jobs run.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { AutoCloseProcessor } from "../../src/tickets/sweeps/auto-close"
import { SlaScanProcessor } from "../../src/tickets/sweeps/sla-scan"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

const T0 = new Date("2026-10-09T08:00:00.000Z")
const clock = new FixedClock(new Date())

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"requester" | "agent">

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
  ws = await seedWorkspace(app, db, { prefix: "sweep", people: { requester: "REQUESTER", agent: "AGENT" } })
  for (const [priority, t] of Object.entries(DEFAULT_SLA_TARGETS)) {
    await db.sLAPolicy.create({
      data: {
        orgId: ws.orgId,
        ticketType: "INCIDENT",
        priority: priority as keyof typeof DEFAULT_SLA_TARGETS,
        responseTargetMinutes: t.response,
        resolutionTargetMinutes: t.resolution,
        responseWarningMinutes: t.responseWarning,
        resolutionWarningMinutes: t.resolutionWarning,
      },
    })
  }
  clock.set(T0)
})

afterAll(async () => {
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await db.sLAPolicy.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: "requester" | "agent") => browser(app, ws.origin, ws.people[who].access)
const at = (minutes: number) => clock.set(new Date(T0.getTime() + minutes * 60_000))
const job = (data: object) => ({ id: "spec", data: { tick: 0, ...data } }) as unknown as Job
const scan = () => app.get(SlaScanProcessor).process(job({ orgId: ws.orgId }))
const autoClose = () => app.get(AutoCloseProcessor).process(job({ orgId: ws.orgId }))
const trail = (ticketId: string, action: "SLA_WARNING" | "SLA_BREACHED" | "TICKET_TRANSITIONED") =>
  db.auditLog.findMany({ where: { orgId: ws.orgId, entityId: ticketId, action } })

describe("the sla scan", () => {
  let id = ""

  it("warns ten minutes before a high incident's thirty-minute response target, once", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Printer offline",
      description: "Floor three",
      impact: "MEDIUM",
      urgency: "HIGH",
    })
    expect(created.body.priority).toBe("HIGH")
    id = created.body.id as string

    at(19)
    expect(await scan()).toBe(0)
    at(20)
    expect(await scan()).toBe(1)
    expect(await scan()).toBe(0)
    const ticket = await db.ticket.findUniqueOrThrow({ where: { id } })
    expect(ticket.responseWarningSentAt).toEqual(new Date(T0.getTime() + 20 * 60_000))
    expect(ticket.responseBreached).toBe(false)
    const [warning] = await trail(id, "SLA_WARNING")
    expect(warning).toMatchObject({ actorKind: "SYSTEM", diff: { clock: "response" } })
  })

  it("breaches at the deadline, once, without bumping the version an agent may be editing", async () => {
    const before = await db.ticket.findUniqueOrThrow({ where: { id } })
    at(30)
    expect(await scan()).toBe(1)
    expect(await scan()).toBe(0)
    const after = await db.ticket.findUniqueOrThrow({ where: { id } })
    expect(after.responseBreached).toBe(true)
    expect(after.version).toBe(before.version)
    expect(await trail(id, "SLA_BREACHED")).toHaveLength(1)
  })
})

describe("auto-close", () => {
  it("closes a ticket resolved seven days ago, as the system, and leaves a newer one", async () => {
    at(31)
    const older = (await as("requester").post("/tickets", { type: "INCIDENT", title: "Old", description: "x", impact: "LOW", urgency: "LOW" })).body
    const newer = (await as("requester").post("/tickets", { type: "INCIDENT", title: "New", description: "x", impact: "LOW", urgency: "LOW" })).body
    const resolve = async (ticket: { id: string; version: number }) => {
      const started = await as("agent").post(`/tickets/${ticket.id}/transitions`, { action: "start", version: ticket.version })
      const resolved = await as("agent").post(`/tickets/${ticket.id}/transitions`, {
        action: "resolve",
        version: started.body.version,
        comment: { body: "Fixed", visibility: "PUBLIC" },
      })
      expect(resolved.status).toBe(200)
    }
    await resolve(older)
    at(40)
    await resolve(newer)

    at(31 + 7 * 1440 + 1)
    expect(await autoClose()).toBe(1)
    expect((await db.ticket.findUniqueOrThrow({ where: { id: older.id } })).status).toBe("CLOSED")
    expect((await db.ticket.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe("RESOLVED")
    const closes = (await trail(older.id, "TICKET_TRANSITIONED")).filter((e) => (e.diff as { automatic?: boolean }).automatic === true)
    expect(closes).toMatchObject([{ actorKind: "SYSTEM", diff: { action: "close", from: "RESOLVED", to: "CLOSED" } }])
  })
})
