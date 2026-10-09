/**
 * Ticket search through real queries (DOMAIN.md §9.1): stemmed and ranked
 * full text, a ticket number as a direct hit, and the same scope as a list —
 * an OWN_TEAM_ONLY agent never finds the other team's ticket, a requester
 * only their own, and nobody another tenant's.
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
let ws: Workspace<"agent" | "requester" | "other" | "admin">
let elsewhere: Workspace<"admin">

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
    prefix: "srch",
    people: { agent: "AGENT", requester: "REQUESTER", other: "REQUESTER", admin: "ADMIN" },
    teams: ["A", "C"],
  })
  elsewhere = await seedWorkspace(app, db, { prefix: "srch-x", people: { admin: "ADMIN" } })
  await db.teamMembership.create({ data: { orgId: ws.orgId, teamId: ws.teams.A ?? "", membershipId: ws.people.agent.membershipId } })
  await db.organization.update({ where: { id: ws.orgId }, data: { agentVisibility: "OWN_TEAM_ONLY" } })
  await app.get(OrganizationLookupService).invalidate({ id: ws.orgId, slug: ws.slug })

  const now = new Date()
  const make = (orgId: string, requesterMembershipId: string, number: number, title: string, description: string, teamId: string | null) =>
    db.ticket.create({
      data: {
        orgId,
        number,
        type: "INCIDENT",
        title,
        description,
        impact: "LOW",
        urgency: "LOW",
        priority: "LOW",
        requesterMembershipId,
        responseClockStartedAt: now,
        resolutionClockStartedAt: now,
        source: "PORTAL",
        teamId,
      },
    })
  const requester = ws.people.requester.membershipId
  await make(ws.orgId, requester, 1, "Printer offline on floor three", "Nothing prints since this morning", ws.teams.A ?? null)
  await make(ws.orgId, requester, 2, "Laptop fan is loud", "It sits next to the printer, if that matters", ws.teams.A ?? null)
  await make(ws.orgId, requester, 3, "Printer toner is empty", "Tray two", ws.teams.C ?? null)
  await make(ws.orgId, ws.people.other.membershipId, 4, "Printer jams", "Someone else's", ws.teams.A ?? null)
  await make(ws.orgId, requester, 404, "VPN drops", "Gateway answers 503 then reconnects", ws.teams.A ?? null)
  await make(elsewhere.orgId, elsewhere.people.admin.membershipId, 1, "Printer on fire", "Another company's printer", null)
})

afterAll(async () => {
  for (const orgId of [ws?.orgId, elsewhere?.orgId]) {
    if (orgId !== undefined) await db.ticket.deleteMany({ where: { orgId } })
  }
  await ws?.cleanup()
  await elsewhere?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const titles = (body: { items: { title: string }[] }) => body.items.map((t) => t.title)
const search = (who: { access: string }, q: string, origin = ws.origin) =>
  browser(app, origin, who.access).get(`/tickets/search?q=${encodeURIComponent(q)}`)

describe("full text", () => {
  it("stems, ranks a title above a description, and keeps to the agent's teams", async () => {
    const res = await search(ws.people.agent, "printers")
    expect(res.status).toBe(200)
    // "Printer toner" is team C's; "Printer on fire" is another tenant's.
    expect(titles(res.body).toSorted()).toEqual(["Laptop fan is loud", "Printer jams", "Printer offline on floor three"])
    // Only its description mentions a printer, so it ranks last.
    expect(titles(res.body).at(-1)).toBe("Laptop fan is loud")
  })

  it("gives an admin the whole workspace, and still nothing of another tenant's", async () => {
    const res = await search(ws.people.admin, "printer")
    expect(titles(res.body).toSorted()).toEqual(["Laptop fan is loud", "Printer jams", "Printer offline on floor three", "Printer toner is empty"])
    const theirs = await search(elsewhere.people.admin, "printer", elsewhere.origin)
    expect(titles(theirs.body)).toEqual(["Printer on fire"])
  })

  it("shows a requester only what they raised", async () => {
    expect(titles((await search(ws.people.other, "printer")).body)).toEqual(["Printer jams"])
  })

  it("narrows by status rather than paging", async () => {
    const res = await browser(app, ws.origin, ws.people.admin.access).get("/tickets/search?q=printer&status=CLOSED")
    expect(res.body.items).toEqual([])
    expect((await browser(app, ws.origin, ws.people.admin.access).get("/tickets/search?q=printer&cursor=x")).status).toBe(400)
  })
})

describe("a ticket number", () => {
  it("is a direct hit, by prefix or bare", async () => {
    expect(titles((await search(ws.people.agent, "INC-000001")).body)).toEqual(["Printer offline on floor three"])
    expect(titles((await search(ws.people.agent, "#2")).body)).toEqual(["Laptop fan is loud"])
  })

  it("outside the scope finds nothing rather than the ticket", async () => {
    expect((await search(ws.people.agent, "INC-3")).body.items).toEqual([])
  })

  it("falls through to full text when no visible ticket has it", async () => {
    expect(titles((await search(ws.people.agent, "404")).body)).toEqual(["VPN drops"])
    // No ticket 503, but one whose description says it.
    expect(titles((await search(ws.people.agent, "503")).body)).toEqual(["VPN drops"])
    expect((await search(ws.people.agent, "9999")).body.items).toEqual([])
  })
})
