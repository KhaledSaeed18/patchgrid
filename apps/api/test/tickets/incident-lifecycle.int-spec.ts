/**
 * M2's exit criterion through the booted app: a requester raises an incident
 * that gets its number, computed priority, deadlines and routed team; an agent
 * assigns, replies, adds an internal note, waits and is resumed by the
 * requester's answer, resolves; the requester closes and reopens; two agents
 * editing at once get a clean conflict; every step is in the trail. A fixed
 * clock makes the deadlines exact.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

const T0 = new Date("2026-10-09T08:00:00.000Z")
const clock = new FixedClock(new Date())
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000).toISOString()

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"requester" | "agent" | "other" | "admin">
let laptop = ""

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
  ws = await seedWorkspace(app, db, {
    prefix: "inc",
    people: { requester: "REQUESTER", agent: "AGENT", other: "AGENT", admin: "ADMIN" },
    teams: ["IT Support"],
  })
  const hardware = await db.category.create({ data: { orgId: ws.orgId, name: "Hardware", depth: 1, defaultTeamId: ws.teams["IT Support"] ?? null } })
  laptop = (await db.category.create({ data: { orgId: ws.orgId, name: "Laptop", depth: 2, parentId: hardware.id } })).id
  for (const ticketType of ["INCIDENT", "SERVICE_REQUEST"] as const) {
    for (const [priority, t] of Object.entries(DEFAULT_SLA_TARGETS)) {
      await db.sLAPolicy.create({
        data: {
          orgId: ws.orgId,
          ticketType,
          priority: priority as keyof typeof DEFAULT_SLA_TARGETS,
          responseTargetMinutes: t.response,
          resolutionTargetMinutes: t.resolution,
          responseWarningMinutes: t.responseWarning,
          resolutionWarningMinutes: t.resolutionWarning,
        },
      })
    }
  }
  // Every session above was minted on the real clock; from here the clock is ours.
  clock.set(T0)
})

afterAll(async () => {
  await db.ticketWatcher.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await db.sLAPolicy.deleteMany({ where: { orgId: ws.orgId } })
  await db.category.deleteMany({ where: { orgId: ws.orgId, parentId: { not: null } } })
  await db.category.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: "requester" | "agent" | "other" | "admin") => browser(app, ws.origin, ws.people[who].access)
const advance = (n: number) => clock.set(new Date(clock.now().getTime() + n * 60_000))

describe("the incident lifecycle", () => {
  let id = ""
  let version = 0
  const transition = async (who: "requester" | "agent" | "admin", action: string, extra: object = {}) => {
    const response = await as(who).post(`/tickets/${id}/transitions`, { action, version, ...extra })
    if (response.status === 200) version = response.body.version as number
    return response
  }

  it("raises an incident with a number, a computed priority, its deadlines and its routed team", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Laptop won't boot",
      description: "Black screen since the update",
      impact: "MEDIUM",
      urgency: "HIGH",
      categoryId: laptop,
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      number: "INC-000001",
      status: "NEW",
      priority: "HIGH",
      team: { id: ws.teams["IT Support"], name: "IT Support" },
      source: "PORTAL",
      sla: { response: { due: minutes(30), breached: false }, resolution: { due: minutes(480) } },
      availableActions: ["cancel"],
      capabilities: { editableFields: ["title", "description"], canCommentInternal: false },
    })
    id = created.body.id as string
    version = created.body.version as number
    expect((await as("requester").post("/tickets", { type: "INCIDENT", title: "x", description: "y", impact: "LOW", urgency: "LOW", priority: "CRITICAL" })).status).toBe(400)
  })

  it("lets an agent assign and start it, and replies publicly — the response", async () => {
    advance(10)
    expect((await transition("agent", "assign", { assigneeMembershipId: ws.people.agent.membershipId })).body.status).toBe("ASSIGNED")
    expect((await transition("agent", "start")).body.status).toBe("IN_PROGRESS")
    const reply = await as("agent").post(`/tickets/${id}/comments`, { body: "Can you hold the power button for 30s?", visibility: "PUBLIC" })
    expect(reply.status).toBe(201)
    const note = await as("agent").post(`/tickets/${id}/comments`, { body: "Probably the firmware update", visibility: "INTERNAL" })
    expect(note.status).toBe(201)
    const ticket = await as("agent").get(`/tickets/${id}`)
    expect(ticket.body.sla.response).toMatchObject({ stoppedAt: minutes(10), breached: false })
    version = ticket.body.version as number
  })

  it("never shows the requester an internal note, nor lets them write one", async () => {
    const thread = await as("requester").get(`/tickets/${id}/comments`)
    expect(thread.body.map((c: { visibility: string }) => c.visibility)).toEqual(["PUBLIC"])
    expect((await as("requester").post(`/tickets/${id}/comments`, { body: "sneaky", visibility: "INTERNAL" })).status).toBe(403)
    const agentThread = await as("agent").get(`/tickets/${id}/comments`)
    expect(agentThread.body).toHaveLength(2)
  })

  it("waits with a public reason, pauses the clock, and the requester's answer resumes it", async () => {
    expect((await transition("agent", "wait")).status).toBe(400)
    expect((await transition("agent", "wait", { comment: { body: "Need your asset tag", visibility: "PUBLIC" } })).body.status).toBe("PENDING")
    advance(90)
    expect((await as("requester").post(`/tickets/${id}/comments`, { body: "It's AT-1234", visibility: "PUBLIC" })).status).toBe(201)
    const ticket = await as("agent").get(`/tickets/${id}`)
    expect(ticket.body.status).toBe("IN_PROGRESS")
    expect(ticket.body.sla.resolution.due).toBe(minutes(480 + 90))
    version = ticket.body.version as number
  })

  it("gives two agents editing at once a clean conflict, not a lost update", async () => {
    const [a, b] = await Promise.all([
      as("agent").patch(`/tickets/${id}`, { version, title: "Laptop won't boot after update" }),
      as("admin").patch(`/tickets/${id}`, { version, urgency: "LOW" }),
    ])
    expect([a.status, b.status].toSorted()).toEqual([200, 409])
    expect((a.status === 409 ? a : b).body.type).toContain("stale-write")
    version = (await as("agent").get(`/tickets/${id}`)).body.version as number
  })

  it("resolves with a public note; the requester closes, then reopens with a fresh clock", async () => {
    advance(30)
    expect((await transition("agent", "resolve", { comment: { body: "Re-flashed the firmware", visibility: "PUBLIC" } })).body.status).toBe("RESOLVED")
    expect((await transition("requester", "close")).body.status).toBe("CLOSED")
    advance(60)
    const reopened = await transition("requester", "reopen")
    expect(reopened.body).toMatchObject({ status: "IN_PROGRESS", reopenCount: 1 })
    expect(reopened.body.sla.resolution.due).toBe(new Date(clock.now().getTime() + 480 * 60_000).toISOString())
    expect((await transition("requester", "resolve", { comment: { body: "fixed", visibility: "PUBLIC" } })).status).toBe(403)
  })

  it("refuses a transition the table does not have", async () => {
    const invalid = await transition("agent", "close")
    expect(invalid.status).toBe(409)
    expect(invalid.body.type).toContain("invalid-transition")
  })

  it("lists it in the right views, and audits every step", async () => {
    expect((await as("requester").get("/tickets?view=mine")).body.items.map((t: { id: string }) => t.id)).toEqual([id])
    expect((await as("agent").get("/tickets?view=assigned")).body.items.map((t: { id: string }) => t.id)).toEqual([id])
    expect((await as("requester").get("/tickets?view=open")).body.items.map((t: { id: string }) => t.id)).toEqual([id])
    expect((await as("requester").get(`/tickets/${id}/audit`)).status).toBe(403)
    const trail = await as("agent").get(`/tickets/${id}/audit`)
    const actions = trail.body.map((e: { action: string }) => e.action)
    expect(actions[0]).toBe("TICKET_CREATED")
    expect(actions).toEqual(expect.arrayContaining(["TICKET_TRANSITIONED", "COMMENT_ADDED", "TICKET_UPDATED"]))
    const automatic = trail.body.find((e: { diff: { automatic?: boolean } }) => e.diff.automatic === true)
    expect(automatic?.diff).toMatchObject({ action: "resume", from: "PENDING", to: "IN_PROGRESS" })
  })
})
