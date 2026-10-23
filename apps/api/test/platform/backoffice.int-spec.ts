/**
 * The back-office end to end (RBAC.md §8, ADR-0040): an operator lists
 * workspaces as metadata and counts, suspends one — whose members are out on
 * their next request, with the reason in the tenant's own log — unsuspends
 * it, and sets its plan. A member's credential reaches none of it.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { ADMIN_ORIGIN, type Operator, signInOperator } from "../support/platform"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "agent" | "requester"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let operator: Operator

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "office", people: { owner: "OWNER", agent: "AGENT", requester: "REQUESTER" } })
  operator = await signInOperator(app, db)
})

afterAll(async () => {
  await operator?.cleanup()
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)

describe("the back-office", () => {
  it("lists and opens a workspace as metadata and counts", async () => {
    await as("requester").post("/tickets", { type: "INCIDENT", title: "Printer", description: "x", impact: "LOW", urgency: "LOW" })
    const list = await operator.get(`/orgs?q=${ws.slug}`)
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([expect.objectContaining({ id: ws.orgId, slug: ws.slug, status: "ACTIVE", plan: "FREE" })])
    const detail = await operator.get(`/orgs/${ws.orgId}`)
    expect(detail.body.counts).toMatchObject({ seats: 2, requesters: 1, tickets: 1, openTickets: 1 })
    // Metadata, never content: no titles, no people.
    expect(JSON.stringify(detail.body)).not.toContain("Printer")
  })

  it("suspends a workspace: its members are out at once, and the tenant's log says who and why", async () => {
    expect((await as("agent").get("/tickets?view=open")).status).toBe(200)
    const suspended = await operator.post(`/orgs/${ws.orgId}/suspend`, { reason: "Abuse report 1234" })
    expect(suspended.status).toBe(200)
    expect(suspended.body.status).toBe("SUSPENDED")
    const refused = await as("agent").get("/tickets?view=open")
    expect(refused.status).toBe(403)
    expect(refused.body.type).toContain("organization-suspended")
    expect((await operator.post(`/orgs/${ws.orgId}/suspend`, { reason: "again" })).status).toBe(409)
    const entry = await db.auditLog.findFirstOrThrow({ where: { orgId: ws.orgId, action: "ORG_SUSPENDED" } })
    expect(entry).toMatchObject({
      actorKind: "PLATFORM",
      actorPlatformAdminId: operator.platformAdminId,
      diff: { reason: "Abuse report 1234" },
    })
  })

  it("unsuspends it, and sets its plan, each in both logs", async () => {
    expect((await operator.post(`/orgs/${ws.orgId}/unsuspend`)).body.status).toBe("ACTIVE")
    expect((await operator.put(`/orgs/${ws.orgId}/plan`, { plan: "PRO" })).body.plan).toBe("PRO")
    const tenantLog = await db.auditLog.findMany({
      where: { orgId: ws.orgId, actorPlatformAdminId: operator.platformAdminId },
      select: { action: true },
    })
    expect(tenantLog.map((e) => e.action).toSorted()).toEqual(["ORG_PLAN_CHANGED", "ORG_SUSPENDED", "ORG_UNSUSPENDED"])
    const platformLog = await db.platformAuditLog.findMany({
      where: { platformAdminId: operator.platformAdminId, targetOrgId: ws.orgId },
      select: { action: true },
    })
    expect(platformLog.map((e) => e.action).toSorted()).toEqual([
      "PLATFORM_ORG_PLAN_SET",
      "PLATFORM_ORG_SUSPENDED",
      "PLATFORM_ORG_UNSUSPENDED",
    ])
  })

  it("answers no member, whatever they hold", async () => {
    const owner = await request(app.getHttpServer())
      .get("/api/v1/platform/orgs")
      .set("Origin", ADMIN_ORIGIN)
      .set("Cookie", ws.people.owner.access)
    expect(owner.status).toBe(401)
    const fromTenant = await request(app.getHttpServer())
      .get("/api/v1/platform/orgs")
      .set("Origin", ws.origin)
      .set("Cookie", ws.people.owner.access)
    expect(fromTenant.status).toBe(403)
  })
})
