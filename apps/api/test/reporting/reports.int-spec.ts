/**
 * The reporting read side against Postgres (ADR-0051): facts follow their
 * tickets through the log, the reconcile builds what the log never saw and
 * counts drift, an older refresh never overwrites a newer one, and the
 * reports' numbers are the tickets' numbers. The app runs as `api`; the spec
 * drains the log by hand, inside the tenant.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventRelay } from "../../src/events/relay"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { PrismaService } from "../../src/prisma/prisma.service"
import { factOf } from "../../src/reporting/domain/fact"
import { ReportingReconcileService } from "../../src/reporting/reporting-reconcile"
import { ReportingRepository } from "../../src/reporting/repositories/reporting.repository"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let owner: PrismaClient
let app: INestApplication
let ws: Workspace<"owner" | "agent" | "requester">

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, owner, { prefix: "report", people: { owner: "OWNER", agent: "AGENT", requester: "REQUESTER" } })
})

afterAll(async () => {
  await owner.ticketFact.deleteMany({ where: { orgId: ws.orgId } })
  await owner.notification.deleteMany({ where: { orgId: ws.orgId } })
  await owner.comment.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await owner.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await owner.$disconnect()
  delete process.env.WORKER_MODE
})

const as = (who: "owner" | "agent" | "requester") => browser(app, ws.origin, ws.people[who].access)
const crossing = { actor: "reports-spec", reason: "drive reporting by hand" }
const inTenant = <T>(fn: () => Promise<T>) => runAsTenant(ws.orgId, crossing, fn)

async function drainReporting(): Promise<void> {
  for (;;) {
    const outcome = await inTenant(() => app.get(EventRelay).drain(ws.orgId, "reporting"))
    if (outcome.kind === "idle" && !outcome.heldBack) return
  }
}

const fact = (ticketId: string) => owner.ticketFact.findUnique({ where: { orgId_ticketId: { orgId: ws.orgId, ticketId } } })

describe("facts follow their tickets through the log", () => {
  it("a new ticket has a fact once the log is read, and an edit that tells nobody still refreshes it", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "VPN down",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    expect(created.status).toBe(201)
    const id = created.body.id as string
    await drainReporting()
    // This workspace was seeded without SLA policies: no clock runs, and the fact says so rather than inventing one.
    expect(await fact(id)).toMatchObject({ priority: "LOW", state: "OPEN", response: "NONE", resolution: "NONE" })

    // An agent raises the impact: priority is recomputed, nobody is told, and the fact still follows.
    const edited = await as("agent").patch(`/tickets/${id}`, { version: created.body.version, impact: "HIGH", urgency: "HIGH" })
    expect(edited.status).toBe(200)
    await drainReporting()
    expect(await fact(id)).toMatchObject({ priority: "CRITICAL", sourceVersion: edited.body.version })
  })
})

describe("writes that tell nobody", () => {
  it("a team-only reassignment and an unassignment still refresh the fact (M12 review)", async () => {
    const team = await owner.team.create({ data: { orgId: ws.orgId, name: `Desk ${String(Date.now())}` } })
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Moved by team",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    const id = created.body.id as string
    const moved = await as("agent").put(`/tickets/${id}/assignment`, { version: created.body.version, teamId: team.id })
    expect(moved.status).toBe(200)
    await drainReporting()
    expect(await fact(id)).toMatchObject({ teamId: team.id, sourceVersion: moved.body.version })
    const cleared = await as("agent").put(`/tickets/${id}/assignment`, { version: moved.body.version, teamId: null })
    expect(cleared.status).toBe(200)
    await drainReporting()
    expect(await fact(id)).toMatchObject({ teamId: null, sourceVersion: cleared.body.version })
    await owner.ticket.update({ where: { id }, data: { teamId: null } })
    await owner.team.delete({ where: { id: team.id } })
  })
})

describe("the reconcile", () => {
  it("builds a fact the log never saw, counts it as drift, and finds nothing the second time", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Seeded before the log",
      description: "x",
      impact: "MEDIUM",
      urgency: "MEDIUM",
    })
    const id = created.body.id as string
    await drainReporting()
    await owner.ticketFact.delete({ where: { orgId_ticketId: { orgId: ws.orgId, ticketId: id } } })
    // Long enough ago that the log should have carried it: a missing fact is drift, not a refresh in flight.
    await owner.$executeRaw`UPDATE "Ticket" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${id}::uuid`

    const first = await inTenant(() => app.get(ReportingReconcileService).reconcile())
    expect(first.drifted).toBeGreaterThanOrEqual(1)
    expect(await fact(id)).toMatchObject({ priority: "MEDIUM", state: "OPEN" })
    expect(await inTenant(() => app.get(ReportingReconcileService).reconcile())).toMatchObject({ drifted: 0 })
  })

  it("rebuilds a fact for a ticket written moments ago without calling it drift", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Just now",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    const id = created.body.id as string
    const before = await inTenant(() => app.get(ReportingReconcileService).reconcile())
    expect(await fact(id)).not.toBeNull()
    expect(before.drifted).toBe(0)
  })

  it("never lets an older refresh overwrite a newer fact", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Raced",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    const id = created.body.id as string
    await drainReporting()
    const row = await owner.ticket.findUniqueOrThrow({ where: { id } })
    const newer = { ...factOf(row), sourceVersion: row.version + 5, priority: "HIGH" as const }
    const older = { ...factOf(row), priority: "LOW" as const }
    await inTenant(() => app.get(PrismaService).transaction(() => app.get(ReportingRepository).upsert(ws.orgId, [newer])))
    await inTenant(() => app.get(PrismaService).transaction(() => app.get(ReportingRepository).upsert(ws.orgId, [older])))
    expect(await fact(id)).toMatchObject({ priority: "HIGH", sourceVersion: row.version + 5 })
  })
})

describe("the reports", () => {
  it("are an admin's, and want a range in order", async () => {
    const range = "from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z"
    expect((await as("agent").get(`/reports/sla?${range}`)).status).toBe(403)
    expect((await as("owner").get(`/reports/sla?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`)).status).toBe(400)
    expect((await as("owner").get(`/reports/sla?from=2024-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`)).status).toBe(400)
    expect((await as("owner").get(`/reports/sla?${range}`)).status).toBe(200)
  })

  it("count what met and missed its targets, with the percentiles of time to resolve", async () => {
    // Four incidents in January, resolved after 60, 120, 180 and 600 minutes against a 480-minute target.
    const base = new Date("2026-01-10T09:00:00.000Z")
    const plus = (minutes: number) => new Date(base.getTime() + minutes * 60_000)
    const ids: string[] = []
    for (const [i, minutes] of [60, 120, 180, 600].entries()) {
      const created = await as("requester").post("/tickets", {
        type: "INCIDENT",
        title: `Old ${String(i)}`,
        description: "x",
        impact: "MEDIUM",
        urgency: "MEDIUM",
      })
      const id = created.body.id as string
      ids.push(id)
      await owner.ticket.update({
        where: { id },
        data: {
          createdAt: base,
          responseClockStartedAt: base,
          resolutionClockStartedAt: base,
          respondBy: plus(60),
          resolveBy: plus(480),
          respondedAt: plus(i === 3 ? 90 : 30),
          resolvedAt: plus(minutes),
          status: "RESOLVED",
          version: { increment: 1 },
        },
      })
    }
    await inTenant(() => app.get(ReportingReconcileService).reconcile())

    const report = await as("owner").get(`/reports/sla?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z&groupBy=priority`)
    expect(report.status).toBe(200)
    expect(report.body.total).toMatchObject({
      resolved: 4,
      resolution: { met: 3, breached: 1 },
      response: { met: 3, breached: 1, running: 0 },
      medianResolutionMinutes: 150,
    })
    // p90 of 60, 120, 180, 600 by linear interpolation: 180 + 0.7 × 420 = 474.
    expect(report.body.total.p90ResolutionMinutes).toBe(474)
    expect(report.body.rows).toEqual([expect.objectContaining({ key: "MEDIUM", resolved: 4 })])

    const workload = await as("owner").get(`/reports/workload?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`)
    expect(workload.status).toBe(200)
    expect(workload.body.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Unassigned", resolvedInRange: 4 })]))

    const backlog = await as("owner").get(`/reports/backlog`)
    expect(backlog.status).toBe(200)
    expect(backlog.body.buckets).toHaveLength(5)
    expect(backlog.body.rows.map((r: { priority: string }) => r.priority)).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    expect(ids).toHaveLength(4)
  })
})
