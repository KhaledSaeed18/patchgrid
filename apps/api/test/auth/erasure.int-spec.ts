/**
 * Erasing one's own account (ADR-0028, ADR-0044): password again; never the
 * last owner of a live workspace; then every session ends, every membership —
 * a removed one included — stops naming the person, and the account becomes
 * a tombstone. What they wrote stays, under "Former member".
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { MAIL_QUEUE } from "../../src/mail/mail.service"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { type Settler, settler } from "../support/queues"
import { browser, HEADERS, seedWorkspace, type Workspace } from "../support/workspace"

const PASSWORD = "correct horse battery staple"
type Who = "owner" | "agent"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let other: Workspace<"owner">
let jobs: Settler
const recorder = new RecordingMailProvider()
let ticketId = ""
let formerMembershipId = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAIL_PROVIDER).useValue(recorder).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "erase", people: { owner: "OWNER", agent: "AGENT" } })
  other = await seedWorkspace(app, db, { prefix: "erase-other", people: { owner: "OWNER" } })
  jobs = settler(app, [MAIL_QUEUE])
  ticketId = (await as("agent").post("/tickets", { type: "INCIDENT", title: "Laptop", description: "x", impact: "LOW", urgency: "LOW" })).body.id as string
  // The agent once belonged to the other workspace too, and was removed from it: still their name there.
  const former = await db.membership.create({
    data: { orgId: other.orgId, userId: ws.people.agent.userId, role: "AGENT", status: "REMOVED", displayName: "agent", joinedAt: new Date() },
  })
  formerMembershipId = former.id
  await db.userOrgIndex.create({
    data: { userId: ws.people.agent.userId, orgId: other.orgId, roleForDisplay: "AGENT", statusForDisplay: "REMOVED", orgSlug: other.slug, orgName: "Other", orgStatus: "ACTIVE" },
  })
})

afterAll(async () => {
  // The extra membership points at the agent's account from the other workspace; it goes first.
  if (formerMembershipId !== "") {
    await db.auditLog.deleteMany({ where: { orgId: other.orgId } })
    await db.membership.deleteMany({ where: { id: formerMembershipId } })
  }
  for (const w of [ws, other]) {
    if (w === undefined) continue
    await db.ticketWatcher.deleteMany({ where: { orgId: w.orgId } })
    await db.notification.deleteMany({ where: { orgId: w.orgId } })
    await db.ticket.deleteMany({ where: { orgId: w.orgId } })
    await db.ticketCounter.deleteMany({ where: { orgId: w.orgId } })
    await w.cleanup()
  }
  await jobs?.close()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const erase = (who: Who, password = PASSWORD) =>
  request(app.getHttpServer()).post("/api/v1/auth/account/erase").set(HEADERS).set("Cookie", ws.people[who].pgId).send({ password })

describe("asking", () => {
  it("wants the password again", async () => {
    expect((await erase("agent", "not the password")).status).toBe(400)
  })

  it("never leaves a live workspace without an owner", async () => {
    const refused = await erase("owner")
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toContain(ws.slug)
  })

  it("hides a removed membership from the picker, though erasure still finds it", async () => {
    const picker = await request(app.getHttpServer()).get("/api/v1/auth/identity").set("Cookie", ws.people.agent.pgId)
    expect(picker.body.workspaces.map((w: { orgId: string }) => w.orgId)).toEqual([ws.orgId])
  })
})

describe("erasing", () => {
  it("ends every session and takes the name out of every workspace, keeping what they wrote", async () => {
    const erased = await erase("agent")
    expect(erased.status, JSON.stringify(erased.body)).toBe(204)
    expect(((erased.headers["set-cookie"] as unknown as string[]) ?? []).some((c) => c.startsWith("pg_id=;"))).toBe(true)
    expect((await as("agent").get("/me")).status).toBe(401)
    expect((await request(app.getHttpServer()).get("/api/v1/auth/identity").set("Cookie", ws.people.agent.pgId)).status).toBe(401)

    const here = await db.membership.findUniqueOrThrow({ where: { id: ws.people.agent.membershipId } })
    expect(here).toMatchObject({ status: "REMOVED", displayName: "Former member", avatarUrl: null })
    expect(here.anonymisedAt).not.toBeNull()
    expect(await db.membership.findUniqueOrThrow({ where: { id: formerMembershipId } })).toMatchObject({ displayName: "Former member" })

    const ticket = await as("owner").get(`/tickets/${ticketId}`)
    expect(ticket.body.requester).toEqual({ membershipId: ws.people.agent.membershipId, displayName: "Former member", external: false })
    expect(await db.auditLog.findFirst({ where: { orgId: ws.orgId, action: "MEMBER_REMOVED", entityId: ws.people.agent.membershipId } })).toMatchObject({
      actorMembershipId: ws.people.agent.membershipId,
      diff: { erased: true },
    })
  })

  it("leaves a tombstone account nobody can sign in to, and frees the address", async () => {
    const account = await db.user.findUniqueOrThrow({ where: { id: ws.people.agent.userId } })
    expect(account.email).toBe(`deleted+${ws.people.agent.userId}@invalid`)
    expect(account).toMatchObject({ name: "", passwordHash: null })
    expect(await db.userOrgIndex.count({ where: { userId: ws.people.agent.userId } })).toBe(0)
    const login = await request(app.getHttpServer()).post("/api/v1/auth/login").set(HEADERS).send({ email: ws.people.agent.email, password: PASSWORD })
    expect(login.status).toBe(401)
    await jobs.settle()
    expect(recorder.sent.filter((m) => m.to === ws.people.agent.email).map((m) => m.subject)).toContain("Your Patchgrid account has been deleted")
  })
})
