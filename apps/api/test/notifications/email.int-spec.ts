/**
 * Notification email end to end (DOMAIN.md §8): a change commits, the notify
 * job writes the inbox and queues mail, the mail job renders it in its
 * tenant and sends — all through the real queues, awaited, never slept on.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { NOTIFY_QUEUE } from "../../src/notifications/notify"
import { OrganizationLookupService } from "../../src/tenancy/organization-lookup.service"
import { type Settler, settler } from "../support/queues"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "requester" | "agent" | "teammate"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let jobs: Settler
const recorder = new RecordingMailProvider()
let ticket = { id: "", version: 0 }

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(recorder)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "mail", people: { requester: "REQUESTER", agent: "AGENT", teammate: "AGENT" } })
  jobs = settler(app, [NOTIFY_QUEUE, MAIL_QUEUE])
})

afterAll(async () => {
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
/** What reached each address since `from`, once every queued job has run. */
async function mailSince(from: number): Promise<{ to: string; subject: string }[]> {
  await jobs.settle()
  return recorder.sent.slice(from).map((m) => ({ to: m.to, subject: m.subject }))
}
const address = (who: Who) => ws.people[who].email

describe("notification email", () => {
  it("confirms a requester's own ticket by email, and tells nobody else by email", async () => {
    const mark = recorder.sent.length
    const created = await as("requester").post("/tickets", { type: "INCIDENT", title: "Monitor flickers", description: "x", impact: "LOW", urgency: "LOW" })
    ticket = { id: created.body.id as string, version: created.body.version as number }
    const sent = await mailSince(mark)
    expect(sent).toEqual([{ to: address("requester"), subject: expect.stringMatching(/^We've received \[INC-\d{6}\]: Monitor flickers$/) }])
    const mail = recorder.sent[mark]
    expect(mail?.from.name).toBe((await db.organization.findUniqueOrThrow({ where: { id: ws.orgId } })).name)
    expect(mail?.html).toContain(`${ws.origin}/tickets/${ticket.id}`)
  })

  it("emails the new assignee, and one email for a burst of replies", async () => {
    const mark = recorder.sent.length
    const assigned = await as("teammate").put(`/tickets/${ticket.id}/assignment`, { version: ticket.version, assigneeMembershipId: ws.people.agent.membershipId })
    expect(assigned.status).toBe(200)
    for (const body of ["On it", "Swapping the cable", "Fixed?"]) {
      await as("agent").post(`/tickets/${ticket.id}/comments`, { body, visibility: "PUBLIC" })
    }
    const sent = await mailSince(mark)
    expect(sent.filter((m) => m.to === address("agent"))).toEqual([{ to: address("agent"), subject: expect.stringMatching(/^Assigned to you/) }])
    expect(sent.filter((m) => m.to === address("requester"))).toEqual([{ to: address("requester"), subject: expect.stringMatching(/^New reply on/) }])
  })

  it("honours a member's choice, which is theirs alone", async () => {
    const off = await as("requester").patch("/notifications/preferences", { email: { COMMENT_PUBLIC: false } })
    expect(off.status).toBe(200)
    expect(off.body.email).toMatchObject({ COMMENT_PUBLIC: false, STATUS_CHANGED: true })
    expect((await as("agent").get("/notifications/preferences")).body.email.COMMENT_PUBLIC).toBe(true)
    expect((await as("requester").patch("/notifications/preferences", { email: { NOT_A_TYPE: false } })).status).toBe(400)

    await as("requester").post("/notifications/read-all", {})
    const mark = recorder.sent.length
    await as("agent").post(`/tickets/${ticket.id}/comments`, { body: "Try now", visibility: "PUBLIC" })
    expect(await mailSince(mark)).toEqual([])
    // In-app still arrives: the choice is about email.
    expect((await as("requester").get("/notifications?unread=true")).body.items).toHaveLength(1)
  })

  it("sends nothing at all while the workspace's kill switch is off", async () => {
    await db.organization.update({ where: { id: ws.orgId }, data: { emailNotificationsEnabled: false } })
    await app.get(OrganizationLookupService).invalidate({ id: ws.orgId, slug: ws.slug })
    const mark = recorder.sent.length
    const current = (await as("agent").get(`/tickets/${ticket.id}`)).body as { version: number }
    await as("agent").put(`/tickets/${ticket.id}/assignment`, { version: current.version, assigneeMembershipId: ws.people.teammate.membershipId })
    expect(await mailSince(mark)).toEqual([])
    expect((await as("requester").get("/notifications/preferences")).body.emailEnabledForOrg).toBe(false)
  })
})
