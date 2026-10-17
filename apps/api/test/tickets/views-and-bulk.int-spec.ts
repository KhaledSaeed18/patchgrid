/**
 * Saved views and bulk actions over HTTP (ADR-0052): a view is a query that
 * runs as its reader, and a bulk action is the single action per ticket, each
 * ticket answering for itself, with progress on the actor's own live stream.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { openStream } from "../support/sse"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let owner: PrismaClient
let app: INestApplication
let ws: Workspace<"lead" | "agent" | "outsider" | "requester">
let other: Workspace<"agent">

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(new RecordingMailProvider()).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, owner, { prefix: "bulk", people: { lead: "AGENT", agent: "AGENT", outsider: "AGENT", requester: "REQUESTER" }, teams: ["Network"] })
  other = await seedWorkspace(app, owner, { prefix: "elsewhere", people: { agent: "AGENT" } })
  // Lead and agent are in Network; the outsider is in no team.
  await owner.teamMembership.createMany({
    data: [
      { orgId: ws.orgId, teamId: ws.teams.Network ?? "", membershipId: ws.people.lead.membershipId, isLead: true },
      { orgId: ws.orgId, teamId: ws.teams.Network ?? "", membershipId: ws.people.agent.membershipId, isLead: false },
    ],
  })
  // Team membership is read at sign-in: sign the two in again by reseeding their access.
  for (const who of ["lead", "agent"] as const) {
    const login = await browser(app, "http://app.lvh.me:3001", "").post("/auth/login", { email: ws.people[who].email, password: "correct horse battery staple", slug: ws.slug })
    const cookies = ((login.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0] ?? "")
    ws.people[who].access = cookies.find((c) => c.startsWith(`pg_at_${ws.slug}=`)) ?? ws.people[who].access
  }
})

afterAll(async () => {
  for (const orgId of [ws.orgId, other.orgId]) {
    await owner.ticketFact.deleteMany({ where: { orgId } })
    await owner.notification.deleteMany({ where: { orgId } })
    await owner.comment.deleteMany({ where: { orgId } })
    await owner.ticket.deleteMany({ where: { orgId } })
    await owner.ticketCounter.deleteMany({ where: { orgId } })
  }
  await ws?.cleanup()
  await other?.cleanup()
  await app?.close()
  await owner.$disconnect()
  delete process.env.WORKER_MODE
})

const as = (who: "lead" | "agent" | "outsider" | "requester") => browser(app, ws.origin, ws.people[who].access)

async function raise(title: string, urgency: "LOW" | "HIGH" = "LOW"): Promise<{ id: string; version: number }> {
  const created = await as("requester").post("/tickets", { type: "INCIDENT", title, description: "x", impact: urgency, urgency })
  expect(created.status).toBe(201)
  return { id: created.body.id as string, version: created.body.version as number }
}

describe("saved views", () => {
  it("are queries: shared with a team, each member sees the view, and the priority filter narrows it", async () => {
    await raise("Low one")
    const critical = await raise("Critical one", "HIGH")

    const saved = await as("agent").post("/views", { name: "Critical open", query: { view: "open", priority: "CRITICAL" }, teamId: ws.teams.Network })
    expect(saved.status).toBe(201)
    expect(saved.body).toMatchObject({ name: "Critical open", team: { name: "Network" }, removable: true })

    // The lead sees it through the team; the outsider, in no team, does not.
    expect((await as("lead").get("/views")).body.map((v: { name: string }) => v.name)).toContain("Critical open")
    expect((await as("outsider").get("/views")).body).toEqual([])

    // Opening it is the list query with its filters, run as the reader.
    const listed = await as("lead").get("/tickets?view=open&priority=CRITICAL")
    expect(listed.body.items.map((t: { id: string }) => t.id)).toEqual([critical.id])

    // Not the colleague's to remove, but the lead's.
    expect((await as("outsider").delete(`/views/${String(saved.body.id)}`)).status).toBe(404)
    expect((await as("lead").delete(`/views/${String(saved.body.id)}`)).status).toBe(204)
  })

  it("are refused to a requester, and a name is its author's once", async () => {
    expect((await as("requester").get("/views")).status).toBe(403)
    expect((await as("agent").post("/views", { name: "Mine", query: { view: "assigned" } })).status).toBe(201)
    expect((await as("agent").post("/views", { name: "Mine", query: { view: "open" } })).status).toBe(409)
    expect((await as("agent").post("/views", { name: "Elsewhere", query: { view: "open" }, teamId: randomUUID() })).status).toBe(400)
  })
})

describe("bulk actions", () => {
  it("assigns many tickets, each decided on its own, and says so per ticket", async () => {
    const a = await raise("Bulk A")
    const b = await raise("Bulk B")
    const stale = await raise("Bulk stale")
    // Someone else moved this one after the agent loaded it.
    const moved = await as("lead").put(`/tickets/${stale.id}/assignment`, { version: stale.version, teamId: ws.teams.Network })
    expect(moved.status).toBe(200)
    const foreign = await browser(app, other.origin, other.people.agent.access).post("/tickets", { type: "INCIDENT", title: "Theirs", description: "x", impact: "LOW", urgency: "LOW" })

    const stream = await openStream(app, ws.origin, ws.people.agent.access)
    const operationId = randomUUID()
    const result = await as("agent").post("/tickets/bulk", {
      operationId,
      tickets: [a, b, stale, { id: foreign.body.id as string, version: 1 }],
      action: { kind: "assign", assigneeMembershipId: ws.people.agent.membershipId },
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ total: 4, done: 2 })
    expect(result.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(["done", "done", "conflict", "not-found"])

    // The progress frame reached the acting agent's own stream.
    const progress = await stream.next((f) => f.event === "bulk-progress")
    expect(progress.data).toEqual({ operationId, processed: 4, total: 4 })
    stream.close()

    // Each change is the single action's: audited, versioned, assigned.
    expect(await owner.ticket.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ assigneeMembershipId: ws.people.agent.membershipId, version: a.version + 1 })
    expect(await owner.auditLog.count({ where: { orgId: ws.orgId, entityId: { in: [a.id, b.id] }, action: "TICKET_ASSIGNED" } })).toBe(2)
    // The other workspace's ticket is untouched.
    expect(await owner.ticket.findUniqueOrThrow({ where: { id: foreign.body.id as string } })).toMatchObject({ assigneeMembershipId: null })
  })

  it("moves tickets with the comment a transition requires, and refuses a move a status does not have", async () => {
    const raised = await raise("Resolve me")
    const started = await as("agent").post(`/tickets/${raised.id}/transitions`, { action: "start", version: raised.version })
    expect(started.status).toBe(200)
    const one = { id: raised.id, version: started.body.version as number }
    const done = await raise("Already cancelled")
    const cancelled = await as("agent").post(`/tickets/${done.id}/transitions`, { action: "cancel", version: done.version, comment: { body: "Duplicate", visibility: "PUBLIC" } })
    expect(cancelled.status).toBe(200)
    const result = await as("agent").post("/tickets/bulk", {
      operationId: randomUUID(),
      tickets: [one, { id: done.id, version: cancelled.body.version as number }],
      action: { kind: "transition", action: "resolve", comment: { body: "Fixed by the network change", visibility: "PUBLIC" } },
    })
    expect(result.status).toBe(200)
    expect(result.body.results).toEqual([
      expect.objectContaining({ outcome: "done" }),
      expect.objectContaining({ outcome: "refused", detail: expect.any(String) }),
    ])
    expect(await owner.ticket.findUniqueOrThrow({ where: { id: one.id } })).toMatchObject({ status: "RESOLVED" })
  })

  it("leaves approving and rejecting changes to one decision at a time", async () => {
    const t = await raise("A change in disguise")
    for (const action of ["approve", "reject"]) {
      expect((await as("agent").post("/tickets/bulk", { operationId: randomUUID(), tickets: [t], action: { kind: "transition", action } })).status).toBe(400)
    }
  })

  it("is an agent's, and takes at most two hundred tickets, each once", async () => {
    const t = await raise("Requester's own")
    expect((await as("requester").post("/tickets/bulk", { operationId: randomUUID(), tickets: [t], action: { kind: "transition", action: "close" } })).status).toBe(403)
    const tooMany = Array.from({ length: 201 }, () => ({ id: randomUUID(), version: 1 }))
    expect((await as("agent").post("/tickets/bulk", { operationId: randomUUID(), tickets: tooMany, action: { kind: "transition", action: "close" } })).status).toBe(400)
    expect((await as("agent").post("/tickets/bulk", { operationId: randomUUID(), tickets: [t, t], action: { kind: "transition", action: "close" } })).status).toBe(400)
    expect((await as("agent").post("/tickets/bulk", { operationId: randomUUID(), tickets: [t], action: { kind: "assign" } })).status).toBe(400)
  })
})
