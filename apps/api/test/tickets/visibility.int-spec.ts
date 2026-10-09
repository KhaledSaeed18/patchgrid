/**
 * Agent visibility through real queries (RBAC.md §4, ADR-0025): under
 * OWN_TEAM_ONLY an agent in two teams sees both teams' tickets, unteamed
 * ones, those assigned to them and those they watch — every branch of the
 * scope — and nothing else, in lists and by id. ALL_TICKETS lifts it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { OrganizationLookupService } from "../../src/tenancy/organization-lookup.service"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"agent" | "requester" | "admin">
const tickets: Record<string, string> = {}

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "vis", people: { agent: "AGENT", requester: "REQUESTER", admin: "ADMIN" }, teams: ["A", "B", "C"] })
  for (const team of ["A", "B"]) {
    await db.teamMembership.create({ data: { orgId: ws.orgId, teamId: ws.teams[team] ?? "", membershipId: ws.people.agent.membershipId } })
  }
  // The agent's team facts are read per request by the auth guard; their old token is fine.
  const now = new Date()
  let number = 0
  const make = async (key: string, over: { teamId?: string | null | undefined; assigneeMembershipId?: string | null }) => {
    number += 1
    tickets[key] = (
      await db.ticket.create({
        data: {
          orgId: ws.orgId,
          number,
          type: "INCIDENT",
          title: key,
          description: key,
          impact: "LOW",
          urgency: "LOW",
          priority: "LOW",
          requesterMembershipId: ws.people.requester.membershipId,
          responseClockStartedAt: now,
          resolutionClockStartedAt: now,
          source: "PORTAL",
          teamId: over.teamId ?? null,
          assigneeMembershipId: over.assigneeMembershipId ?? null,
        },
      })
    ).id
  }
  await make("team-a", { teamId: ws.teams.A })
  await make("team-b", { teamId: ws.teams.B })
  await make("no-team", { teamId: null })
  await make("team-c", { teamId: ws.teams.C })
  await make("team-c-assigned", { teamId: ws.teams.C, assigneeMembershipId: ws.people.agent.membershipId })
  await make("team-c-watched", { teamId: ws.teams.C })
  await db.ticketWatcher.create({
    data: { orgId: ws.orgId, ticketId: tickets["team-c-watched"] ?? "", membershipId: ws.people.agent.membershipId, addedByMembershipId: ws.people.admin.membershipId },
  })
  await setVisibility("OWN_TEAM_ONLY")
})

async function setVisibility(value: "OWN_TEAM_ONLY" | "ALL_TICKETS") {
  await db.organization.update({ where: { id: ws.orgId }, data: { agentVisibility: value } })
  await app.get(OrganizationLookupService).invalidate({ id: ws.orgId, slug: ws.slug })
}

afterAll(async () => {
  await db.ticketWatcher.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const titles = (body: { items: { title: string }[] }) => body.items.map((t) => t.title).toSorted()

describe("OWN_TEAM_ONLY", () => {
  it("shows a two-team agent every branch of their scope, and not the other team's ticket", async () => {
    const open = await browser(app, ws.origin, ws.people.agent.access).get("/tickets?view=open&limit=100")
    expect(titles(open.body)).toEqual(["no-team", "team-a", "team-b", "team-c-assigned", "team-c-watched"])
  })

  it("is a 404 by id for the ticket outside it, and a read for one inside", async () => {
    const agent = browser(app, ws.origin, ws.people.agent.access)
    expect((await agent.get(`/tickets/${tickets["team-c"]}`)).status).toBe(404)
    expect((await agent.get(`/tickets/${tickets["team-b"]}`)).status).toBe(200)
  })

  it("never narrows an admin", async () => {
    const all = await browser(app, ws.origin, ws.people.admin.access).get("/tickets?view=open&limit=100")
    expect(all.body.items).toHaveLength(6)
  })

  it("the teams view is both of the agent's teams at once", async () => {
    const teams = await browser(app, ws.origin, ws.people.agent.access).get("/tickets?view=teams&limit=100")
    expect(titles(teams.body)).toEqual(["team-a", "team-b"])
  })
})

describe("ALL_TICKETS", () => {
  it("lifts the narrowing for agents", async () => {
    await setVisibility("ALL_TICKETS")
    const open = await browser(app, ws.origin, ws.people.agent.access).get("/tickets?view=open&limit=100")
    expect(open.body.items).toHaveLength(6)
  })
})
