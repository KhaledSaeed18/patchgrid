/**
 * The live stream end to end (ADR-0008, DOMAIN.md §8): a change commits, the
 * stream of each member who may read the ticket says so, and nobody else's
 * does. Absence is proved with a sentinel: an event the stream must receive,
 * caused after the one it must not — the first to arrive tells which.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { RevocationEpochService } from "../../src/auth/revocation/revocation-epoch.service"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { OUTBOX_DRAIN_QUEUE } from "../../src/events/drain-requests"
import { OrganizationLookupService } from "../../src/tenancy/organization-lookup.service"
import { type Settler, settler } from "../support/queues"
import { type Frame, openStream, type Stream } from "../support/sse"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "requester" | "net" | "sec" | "admin"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
const open: Stream[] = []

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
    prefix: "live",
    people: { requester: "REQUESTER", net: "AGENT", sec: "AGENT", admin: "ADMIN" },
    teams: ["Network", "Security"],
  })
  await db.teamMembership.create({ data: { orgId: ws.orgId, teamId: ws.teams.Network ?? "", membershipId: ws.people.net.membershipId } })
  await db.teamMembership.create({ data: { orgId: ws.orgId, teamId: ws.teams.Security ?? "", membershipId: ws.people.sec.membershipId } })
  await db.organization.update({ where: { id: ws.orgId }, data: { agentVisibility: "OWN_TEAM_ONLY" } })
  await app.get(OrganizationLookupService).invalidate({ id: ws.orgId, slug: ws.slug })
  jobs = settler(app, [OUTBOX_DRAIN_QUEUE])
})

afterAll(async () => {
  for (const stream of open) stream.close()
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketWatcher.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
async function stream(who: Who, headers: Record<string, string> = {}): Promise<Stream> {
  const s = await openStream(app, ws.origin, ws.people[who].access, headers)
  open.push(s)
  return s
}
const about = (ticketId: string) => (f: Frame) => f.event === "ticket-updated" && (f.data as { ticketId: string }).ticketId === ticketId
const ticketsIn = (s: Stream) => s.frames.filter((f) => f.event === "ticket-updated").map((f) => (f.data as { ticketId: string }).ticketId)

async function raise(title: string): Promise<{ id: string; version: number }> {
  const created = await as("requester").post("/tickets", { type: "INCIDENT", title, description: "x", impact: "LOW", urgency: "LOW" })
  expect(created.status).toBe(201)
  return { id: created.body.id as string, version: created.body.version as number }
}

describe("the live stream", () => {
  it("is a 401 without a session", async () => {
    const s = await openStream(app, ws.origin, "")
    expect(s.status).toBe(401)
  })

  it("tells everyone who may read an unteamed ticket, and then only its team", async () => {
    const [net, sec, admin] = [await stream("net"), await stream("sec"), await stream("admin")]
    const ticket = await raise("Switch is down")
    // Unteamed: both own-team agents may read it (RBAC.md §4).
    await Promise.all([net.next(about(ticket.id)), sec.next(about(ticket.id)), admin.next(about(ticket.id))])

    const routed = await as("admin").put(`/tickets/${ticket.id}/assignment`, { version: ticket.version, teamId: ws.teams.Network })
    expect(routed.status).toBe(200)
    await net.next(about(ticket.id))

    // Sentinel: an unteamed ticket Security may read, raised after the routing.
    const sentinel = await raise("Badge reader")
    await sec.next(about(sentinel.id))
    expect(ticketsIn(sec)).toEqual([ticket.id, sentinel.id])
    expect(ticketsIn(admin)).toEqual([ticket.id, ticket.id, sentinel.id])
  })

  it("delivers a notification live to its recipient alone, and replays it after Last-Event-ID", async () => {
    const [net, sec] = [await stream("net"), await stream("sec")]
    const ticket = await raise("Printer queue stuck")
    const assigned = await as("admin").put(`/tickets/${ticket.id}/assignment`, { version: ticket.version, assigneeMembershipId: ws.people.net.membershipId })
    expect(assigned.status).toBe(200)
    const live = await net.next((f) => f.event === "notification")
    expect(live.data).toMatchObject({ type: "TICKET_ASSIGNED", ticketId: ticket.id })
    expect(live.id).toBe((live.data as { id: string }).id)
    await jobs.settle()
    expect(sec.frames.filter((f) => f.event === "notification")).toEqual([])

    // A reply while net is away; reconnecting from the assignment replays it.
    net.close()
    await as("requester").post(`/tickets/${ticket.id}/comments`, { body: "Still stuck", visibility: "PUBLIC" })
    await jobs.settle()
    const back = await stream("net", { "Last-Event-ID": live.id ?? "" })
    const replayed = await back.next((f) => f.event === "notification")
    expect(replayed.data).toMatchObject({ type: "COMMENT_PUBLIC", ticketId: ticket.id })
  })

  it("refuses a token minted before the member's access changed", async () => {
    // A role or team change bumps the revocation epoch. A running stream
    // re-checks it every heartbeat (a unit test on fake timers); a new one is
    // refused outright.
    await app.get(RevocationEpochService).bump(ws.people.sec.membershipId)
    expect((await openStream(app, ws.origin, ws.people.sec.access)).status).toBe(401)
  })
})
