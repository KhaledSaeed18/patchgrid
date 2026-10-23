/**
 * Notifications end to end (DOMAIN.md §8): a change commits with its event,
 * the `notify` consumer reads it from the outbox in its tenant, the inbox
 * fills — through the real relay and worker, awaited rather than slept on. A burst of replies
 * is one unread row; an internal note never reaches the requester; marking
 * read is the reader's own business.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { OUTBOX_DRAIN_QUEUE } from "../../src/events/drain-requests"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"requester" | "agent" | "watcher">
let ticketId = ""
let jobs: Settler

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "note", people: { requester: "REQUESTER", agent: "AGENT", watcher: "AGENT" } })
  jobs = settler(app, [OUTBOX_DRAIN_QUEUE])
})

afterAll(async () => {
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

const as = (who: "requester" | "agent" | "watcher") => browser(app, ws.origin, ws.people[who].access)

type Inbox = { items: { id: string; type: string; title: string; count: number; readAt: string | null }[]; unreadCount: number }

/** The worker runs beside the spec: let every queued notification land, then read. */
async function inbox(who: "requester" | "agent" | "watcher"): Promise<Inbox> {
  await jobs.settle()
  return (await as(who).get("/notifications")).body as Inbox
}

describe("the inbox", () => {
  it("tells a member who was made to watch, and the assignee who was assigned", async () => {
    const created = await as("requester").post("/tickets", {
      type: "INCIDENT",
      title: "Scanner jams",
      description: "x",
      impact: "LOW",
      urgency: "LOW",
    })
    ticketId = created.body.id as string
    const assigned = await as("agent").put(`/tickets/${ticketId}/assignment`, {
      version: created.body.version,
      assigneeMembershipId: ws.people.watcher.membershipId,
    })
    expect(assigned.status).toBe(200)
    await as("agent").put(`/tickets/${ticketId}/watchers/${ws.people.agent.membershipId}`, {})
    const watcherInbox = await inbox("watcher")
    expect(watcherInbox.items.find((n) => n.type === "TICKET_ASSIGNED")?.title).toMatch(/^Assigned to you — INC-\d{6}: Scanner jams$/)
    // Watching on your own say-so is not news.
    expect((await inbox("agent")).items.map((n) => n.type)).not.toContain("WATCHER_ADDED")
  })

  it("collapses a burst of replies into one unread row with a count", async () => {
    for (const body of ["Looking", "Still looking", "Found it"]) {
      expect((await as("agent").post(`/tickets/${ticketId}/comments`, { body, visibility: "PUBLIC" })).status).toBe(201)
    }
    const body = await inbox("requester")
    expect(body.items.filter((n) => n.type === "COMMENT_PUBLIC")).toEqual([expect.objectContaining({ count: 3 })])
    expect(body.unreadCount).toBe(1)
  })

  it("never tells the requester about an internal note, and tells the assignee", async () => {
    await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Firmware again", visibility: "INTERNAL" })
    expect((await inbox("watcher")).items.map((n) => n.type)).toContain("COMMENT_INTERNAL")
    const requester = await as("requester").get("/notifications")
    expect(requester.body.items.map((n: { type: string }) => n.type)).not.toContain("COMMENT_INTERNAL")
  })

  it("marks read for its owner only, and a new reply then starts a fresh row", async () => {
    const mine = await inbox("requester")
    const id = mine.items[0]?.id ?? ""
    expect((await as("agent").post(`/notifications/${id}/read`, {})).status).toBe(404)
    expect((await as("requester").post(`/notifications/${id}/read`, {})).status).toBe(204)
    expect((await as("requester").get("/notifications?unread=true")).body.items).toEqual([])

    await as("agent").post(`/tickets/${ticketId}/comments`, { body: "One more thing", visibility: "PUBLIC" })
    const after = await inbox("requester")
    expect(after.items.filter((n) => n.type === "COMMENT_PUBLIC")).toHaveLength(2)
    expect(after.unreadCount).toBe(1)
    expect((await as("requester").post("/notifications/read-all", {})).status).toBe(204)
    expect((await as("requester").get("/notifications")).body.unreadCount).toBe(0)
  })
})
