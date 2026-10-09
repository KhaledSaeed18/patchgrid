/**
 * Teams through the booted AppModule (ADR-0025): an admin builds a team and
 * picks its lead; the lead then manages that team's members and no other's;
 * the single-lead rule and the epoch bump hold against the real database and
 * Redis.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"admin" | "lead" | "agent" | "requester">
const clock = new FixedClock(new Date())

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
  await app.init()
  ws = await seedWorkspace(app, db, {
    prefix: "teams",
    people: { admin: "ADMIN", lead: "AGENT", agent: "AGENT", requester: "REQUESTER" },
    teams: ["Security"],
  })
})

afterAll(async () => {
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: "admin" | "lead" | "agent" | "requester") => browser(app, ws.origin, ws.people[who].access)

/** A fresh session for someone whose epoch was just bumped — a second later, as ties go to the revocation. */
async function relogin(who: "lead" | "agent"): Promise<void> {
  clock.advance(1_000)
  const response = await browser(app, ws.origin, ws.people[who].pgId).post("/auth/sessions", { slug: ws.slug })
  const access = ((response.headers["set-cookie"] as unknown as string[]) ?? []).map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith(`pg_at_${ws.slug}=`))
  ws.people[who].access = access ?? ""
}

describe("teams", () => {
  let network = ""

  it("an admin creates a team; names are unique; requesters cannot even list teams", async () => {
    const created = await as("admin").post("/teams", { name: "Network", description: "Switches and Wi-Fi" })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: "Network", isActive: true, memberCount: 0, lead: null, members: [] })
    network = created.body.id as string
    expect((await as("admin").post("/teams", { name: "Network" })).status).toBe(409)
    expect((await as("lead").post("/teams", { name: "Field" })).status).toBe(403)
    expect((await as("requester").get("/teams")).status).toBe(403)
    expect((await as("agent").get("/teams")).body.map((t: { name: string }) => t.name)).toEqual(["Network", "Security"])
  })

  it("the admin adds the lead-to-be and makes them lead; the lead's old token dies", async () => {
    expect((await as("admin").put(`/teams/${network}/members/${ws.people.lead.membershipId}`)).status).toBe(204)
    const led = await as("admin").put(`/teams/${network}/lead`, { membershipId: ws.people.lead.membershipId })
    expect(led.status).toBe(200)
    expect(led.body.lead).toEqual({ membershipId: ws.people.lead.membershipId, displayName: "lead" })
    expect((await as("lead").get("/teams")).status).toBe(401)
    await relogin("lead")
    expect((await as("lead").get("/teams")).status).toBe(200)
  })

  it("the lead manages their own team's members and no other team's", async () => {
    expect((await as("lead").put(`/teams/${network}/members/${ws.people.agent.membershipId}`)).status).toBe(204)
    expect((await as("lead").put(`/teams/${ws.teams.Security}/members/${ws.people.agent.membershipId}`)).status).toBe(403)
    expect((await as("lead").put(`/teams/${network}/lead`, { membershipId: ws.people.agent.membershipId })).status).toBe(403)
    expect((await as("lead").put(`/teams/${network}/members/${ws.people.requester.membershipId}`)).status).toBe(409)

    // Joining bumped the agent's epoch too.
    expect((await as("agent").get(`/teams/${network}`)).status).toBe(401)
    await relogin("agent")
    const detail = await as("agent").get(`/teams/${network}`)
    expect(detail.body.members.map((m: { displayName: string; isLead: boolean }) => [m.displayName, m.isLead])).toEqual([
      ["lead", true],
      ["agent", false],
    ])
  })

  it("moving the lead leaves exactly one lead in the database", async () => {
    expect((await as("admin").put(`/teams/${network}/lead`, { membershipId: ws.people.agent.membershipId })).status).toBe(200)
    expect(await db.teamMembership.count({ where: { orgId: ws.orgId, teamId: network, isLead: true } })).toBe(1)
    expect((await db.teamMembership.findFirstOrThrow({ where: { orgId: ws.orgId, teamId: network, isLead: true } })).membershipId).toBe(ws.people.agent.membershipId)
  })

  it("a deactivated team keeps its members but takes no changes", async () => {
    expect((await as("admin").patch(`/teams/${network}`, { isActive: false })).body).toMatchObject({ isActive: false, memberCount: 2 })
    expect((await as("admin").delete(`/teams/${network}/members/${ws.people.lead.membershipId}`)).status).toBe(409)
  })

  it("audited each change", async () => {
    const actions = (await db.auditLog.findMany({ where: { orgId: ws.orgId }, select: { action: true } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(["TEAM_CREATED", "TEAM_MEMBER_ADDED", "TEAM_LEAD_CHANGED", "TEAM_UPDATED"]))
  })
})
