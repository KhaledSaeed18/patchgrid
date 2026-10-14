/**
 * M4 end to end (DOMAIN.md §1, §2.2, §2.3): a Problem raised from incidents
 * and worked to a known error and a root cause; a Change raised from the
 * Problem, planned, approved by a team lead, started inside its window and
 * implemented; the links read from both ends; and the one-admin workspace
 * that still ships a change by approving its own.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { NOTIFY_QUEUE } from "../../src/notifications/notify"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "requester" | "agent" | "lead" | "admin"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let solo: Workspace<"owner">
let jobs: Settler
const incidents: string[] = []
let problem = { id: "", version: 0 }
let change = { id: "", version: 0 }

const HOUR = 3_600_000

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, {
    prefix: "m4",
    people: { requester: "REQUESTER", agent: "AGENT", lead: "AGENT", admin: "ADMIN" },
    teams: ["Network"],
  })
  await db.teamMembership.create({ data: { orgId: ws.orgId, teamId: ws.teams.Network ?? "", membershipId: ws.people.lead.membershipId, isLead: true } })
  // The lead's token predates the team row; the auth guard reads team facts fresh on each request.
  solo = await seedWorkspace(app, db, { prefix: "solo", people: { owner: "OWNER" } })
  jobs = settler(app, [NOTIFY_QUEUE])
})

afterAll(async () => {
  for (const orgId of [ws.orgId, solo.orgId]) {
    await db.notification.deleteMany({ where: { orgId } })
    await db.ticketLink.deleteMany({ where: { orgId } })
    await db.changeApproval.deleteMany({ where: { orgId } })
    await db.problemDetails.deleteMany({ where: { orgId } })
    await db.changeDetails.deleteMany({ where: { orgId } })
    await db.comment.deleteMany({ where: { orgId } })
    await db.ticketWatcher.deleteMany({ where: { orgId } })
    await db.ticket.deleteMany({ where: { orgId } })
    await db.ticketCounter.deleteMany({ where: { orgId } })
  }
  await ws?.cleanup()
  await solo?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const raise = async (who: Who, body: object) => {
  const response = await as(who).post("/tickets", { impact: "MEDIUM", urgency: "MEDIUM", description: "x", ...body })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body as { id: string; version: number; number: string; status: string; change: unknown; problem: unknown }
}
const move = (who: Who, ticket: { id: string; version: number }, action: string, extra: object = {}) =>
  as(who).post(`/tickets/${ticket.id}/transitions`, { action, version: ticket.version, ...extra })
const edit = (who: Who, ticket: { id: string; version: number }, body: object) =>
  as(who).patch(`/tickets/${ticket.id}`, { version: ticket.version, ...body })

describe("a problem", () => {
  it("is raised by an agent from incidents, which then read as caused by it", async () => {
    for (const title of ["VPN drops at 9", "VPN drops at 10"]) incidents.push((await raise("requester", { type: "INCIDENT", title })).id)
    expect((await as("requester").post("/tickets", { type: "PROBLEM", title: "x", description: "x", impact: "LOW", urgency: "LOW" })).status).toBe(403)
    const created = await raise("agent", { type: "PROBLEM", title: "VPN concentrator leases", causedIncidentIds: incidents })
    expect(created).toMatchObject({ status: "NEW", number: expect.stringMatching(/^PRB-\d{6}$/), problem: { rootCause: null, workaround: null }, change: null })
    problem = created
    const fromProblem = (await as("agent").get(`/tickets/${problem.id}/links`)).body as { kind: string }[]
    expect(fromProblem.map((l) => l.kind)).toEqual(["CAUSES", "CAUSES"])
    const fromIncident = (await as("agent").get(`/tickets/${incidents[0] ?? ""}/links`)).body as { kind: string; ticket: { id: string } }[]
    expect(fromIncident).toEqual([expect.objectContaining({ kind: "CAUSED_BY", ticket: expect.objectContaining({ id: problem.id }) })])
  })

  it("becomes a known error only with a workaround, and resolves only with a root cause", async () => {
    let r = await move("agent", problem, "start")
    expect(r.status).toBe(200)
    problem = r.body
    expect((await move("agent", problem, "workaround")).status).toBe(409)
    r = await edit("agent", problem, { problem: { workaround: "Reconnect; the lease renews" } })
    expect(r.status).toBe(200)
    problem = r.body
    r = await move("agent", problem, "workaround")
    expect(r.body).toMatchObject({ status: "KNOWN_ERROR", problem: { knownErrorAt: expect.any(String) } })
    problem = r.body
    expect(r.body.availableActions).not.toContain("resolve")
    r = await edit("agent", problem, { problem: { rootCause: "Lease table fills after 64 clients" } })
    problem = r.body
    r = await move("agent", problem, "resolve")
    expect(r.body).toMatchObject({ status: "RESOLVED" })
    problem = r.body
    expect(r.body.capabilities.editableFields).not.toContain("rootCause")
  })
})

describe("a change", () => {
  it("is raised from the problem as a draft, and submitted only with its whole plan", async () => {
    change = await raise("agent", { type: "CHANGE", title: "Raise the lease table size", resolvesProblemId: problem.id })
    expect(change).toMatchObject({ status: "DRAFT", number: expect.stringMatching(/^CHG-\d{6}$/) })
    const links = (await as("agent").get(`/tickets/${change.id}/links`)).body as { kind: string }[]
    expect(links.map((l) => l.kind)).toEqual(["RESOLVES"])
    const refused = await move("agent", change, "submit")
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toContain("plannedStart")
    const start = new Date(Date.now() + 3 * HOUR).toISOString()
    const end = new Date(Date.now() + 4 * HOUR).toISOString()
    expect((await edit("agent", change, { change: { plannedStart: end, plannedEnd: start } })).status).toBe(400)
    const planned = await edit("agent", change, {
      teamId: undefined,
      change: { plannedStart: start, plannedEnd: end, risk: "MEDIUM", implementationPlan: "Bump the setting, restart off-peak", rollbackPlan: "Revert the setting" },
    })
    expect(planned.status).toBe(200)
    change = planned.body
    // Route it to Network, so its lead may decide.
    const routed = await as("admin").put(`/tickets/${change.id}/assignment`, { version: change.version, teamId: ws.teams.Network })
    change = routed.body
    const submitted = await move("agent", change, "submit")
    expect(submitted.body).toMatchObject({ status: "AWAITING_APPROVAL" })
    change = submitted.body
    expect(submitted.body.capabilities.editableFields).not.toContain("risk")
  })

  it("waits in the lead's approval inbox and tells them so; its own requester cannot approve it", async () => {
    const inbox = await as("lead").get("/tickets?view=approvals")
    expect(inbox.body.items.map((t: { id: string }) => t.id)).toEqual([change.id])
    expect((await as("agent").get("/tickets?view=approvals")).body.items).toEqual([])
    await jobs.settle()
    const told = (await as("lead").get("/notifications")).body.items as { type: string }[]
    expect(told.map((n) => n.type)).toContain("CHANGE_AWAITING_APPROVAL")
    expect((await move("agent", change, "approve")).status).toBe(403)
  })

  it("is rejected with a reason back to a draft, then resubmitted and approved by the lead", async () => {
    const rejected = await move("lead", change, "reject", { comment: { body: "Do it after the quarter close", visibility: "PUBLIC" } })
    expect(rejected.body).toMatchObject({ status: "DRAFT", change: { approvals: [{ decision: "REJECTED", reason: "Do it after the quarter close" }] } })
    change = rejected.body
    change = (await move("agent", change, "submit")).body
    const approved = await move("lead", change, "approve")
    expect(approved.body).toMatchObject({ status: "APPROVED" })
    expect(approved.body.change.approvals.map((a: { decision: string; selfApproved: boolean }) => [a.decision, a.selfApproved])).toEqual([
      ["APPROVED", false],
      ["REJECTED", false],
    ])
    change = approved.body
  })

  it("asks before starting more than an hour early, then runs to implemented and closed", async () => {
    const early = await move("agent", change, "start")
    expect(early.status).toBe(409)
    expect(early.body.type).toContain("change-window-early")
    let r = await move("agent", change, "start", { confirm: true })
    expect(r.body).toMatchObject({ status: "IN_PROGRESS", assignee: { membershipId: ws.people.agent.membershipId } })
    change = r.body
    expect((await move("agent", change, "complete")).status).toBe(409)
    change = (await edit("agent", change, { change: { outcomeNotes: "Raised to 256; no drops since" } })).body
    r = await move("agent", change, "complete")
    expect(r.body).toMatchObject({ status: "IMPLEMENTED", resolvedAt: expect.any(String) })
    change = r.body
    r = await move("agent", change, "close")
    expect(r.body).toMatchObject({ status: "CLOSED", availableActions: [] })
  })
})

describe("links", () => {
  it("are stated once: a repeat is a conflict, a self-link and a wrong pair are refused", async () => {
    const [a = "", b = ""] = incidents
    const first = await as("agent").post(`/tickets/${a}/links`, { kind: "RELATES_TO", ticketId: b })
    expect(first.status).toBe(201)
    expect((await as("agent").post(`/tickets/${b}/links`, { kind: "RELATES_TO", ticketId: a })).status).toBe(409)
    expect((await as("agent").post(`/tickets/${a}/links`, { kind: "RELATES_TO", ticketId: a })).status).toBe(400)
    expect((await as("agent").post(`/tickets/${a}/links`, { kind: "RESOLVED_BY", ticketId: change.id })).status).toBe(400)
    expect((await as("requester").post(`/tickets/${a}/links`, { kind: "RELATES_TO", ticketId: b })).status).toBe(403)
  })

  it("follow a duplicate to its survivor, and come off from either end", async () => {
    const [a = "", b = ""] = incidents
    const third = (await raise("requester", { type: "INCIDENT", title: "VPN drops at 11" })).id
    expect((await as("agent").post(`/tickets/${b}/links`, { kind: "DUPLICATE_OF", ticketId: a })).status).toBe(201)
    // `third` duplicates `b`, which is itself a duplicate: it lands on the survivor, `a`.
    const marked = await as("agent").post(`/tickets/${third}/links`, { kind: "DUPLICATE_OF", ticketId: b })
    expect(marked.body).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "DUPLICATE_OF", ticket: expect.objectContaining({ id: a }) })]))
    const fromA = (await as("agent").get(`/tickets/${a}/links`)).body as { id: string; kind: string }[]
    const dup = fromA.find((l) => l.kind === "HAS_DUPLICATE")
    expect(dup).toBeDefined()
    const removed = await as("agent").delete(`/tickets/${a}/links/${dup?.id ?? ""}`)
    expect(removed.status).toBe(200)
  })
})

describe("the one-admin workspace", () => {
  it("ships a change by approving its own, and the approval says so", async () => {
    const owner = browser(app, solo.origin, solo.people.owner.access)
    const start = new Date(Date.now() + 30 * 60_000).toISOString()
    const end = new Date(Date.now() + 90 * 60_000).toISOString()
    let r = await owner.post("/tickets", {
      type: "CHANGE",
      title: "First change ever",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
      change: { plannedStart: start, plannedEnd: end, risk: "LOW", implementationPlan: "Do it", rollbackPlan: "Undo it" },
    })
    r = await owner.post(`/tickets/${r.body.id}/transitions`, { action: "submit", version: r.body.version })
    expect(r.body.availableActions).toEqual(["approve", "cancel"])
    r = await owner.post(`/tickets/${r.body.id}/transitions`, { action: "approve", version: r.body.version })
    expect(r.body).toMatchObject({ status: "APPROVED", change: { approvals: [{ decision: "APPROVED", selfApproved: true }] } })
    const trail = await owner.get(`/tickets/${r.body.id}/audit`)
    expect(trail.body.map((e: { action: string }) => e.action)).toContain("CHANGE_SELF_APPROVED")
  })
})
