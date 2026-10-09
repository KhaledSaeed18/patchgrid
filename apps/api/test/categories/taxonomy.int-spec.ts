/**
 * Categories and SLA policies through the booted app: admins shape a
 * three-level tree that requesters read (active branches only), moves that
 * would break the tree are refused by field, and an SLA change is audited.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"admin" | "agent" | "requester">

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "taxo", people: { admin: "ADMIN", agent: "AGENT", requester: "REQUESTER" }, teams: ["Repairs"] })
  await db.sLAPolicy.create({
    data: {
      orgId: ws.orgId,
      ticketType: "INCIDENT",
      priority: "HIGH",
      responseTargetMinutes: DEFAULT_SLA_TARGETS.HIGH.response,
      resolutionTargetMinutes: DEFAULT_SLA_TARGETS.HIGH.resolution,
      responseWarningMinutes: DEFAULT_SLA_TARGETS.HIGH.responseWarning,
      resolutionWarningMinutes: DEFAULT_SLA_TARGETS.HIGH.resolutionWarning,
    },
  })
})

afterAll(async () => {
  await db.sLAPolicy.deleteMany({ where: { orgId: ws.orgId } })
  await db.category.deleteMany({ where: { orgId: ws.orgId, depth: 3 } })
  await db.category.deleteMany({ where: { orgId: ws.orgId, depth: 2 } })
  await db.category.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: "admin" | "agent" | "requester") => browser(app, ws.origin, ws.people[who].access)

describe("categories", () => {
  const ids = { hardware: "", laptop: "", screen: "", software: "" }

  it("an admin builds three levels; a fourth is refused on the field", async () => {
    ids.hardware = (await as("admin").post("/categories", { name: "Hardware", defaultTeamId: ws.teams.Repairs })).body.id
    ids.laptop = (await as("admin").post("/categories", { name: "Laptop", parentId: ids.hardware })).body.id
    const screen = await as("admin").post("/categories", { name: "Screen", parentId: ids.laptop })
    expect(screen.body).toMatchObject({ depth: 3, parentId: ids.laptop })
    ids.screen = screen.body.id
    const fourth = await as("admin").post("/categories", { name: "Pixel", parentId: ids.screen })
    expect(fourth.status).toBe(400)
    expect(fourth.body.errors[0].path).toBe("parentId")
    ids.software = (await as("admin").post("/categories", { name: "Software" })).body.id
  })

  it("names are unique per parent, not per workspace", async () => {
    expect((await as("admin").post("/categories", { name: "Other", parentId: ids.hardware })).status).toBe(201)
    expect((await as("admin").post("/categories", { name: "Other", parentId: ids.software })).status).toBe(201)
    expect((await as("admin").post("/categories", { name: "Other", parentId: ids.hardware })).status).toBe(409)
  })

  it("refuses a move that would go past three levels, and recomputes depths on one that fits", async () => {
    const tooDeep = await as("admin").patch(`/categories/${ids.hardware}`, { parentId: ids.software })
    expect(tooDeep.status).toBe(400)
    expect((await as("admin").patch(`/categories/${ids.laptop}`, { parentId: null })).body.depth).toBe(1)
    expect((await db.category.findUniqueOrThrow({ where: { id: ids.screen } })).depth).toBe(2)
  })

  it("requesters read the active tree only; deactivating a branch hides everything under it", async () => {
    expect((await as("requester").post("/categories", { name: "Mine" })).status).toBe(403)
    expect((await as("admin").patch(`/categories/${ids.laptop}`, { isActive: false })).status).toBe(200)
    const seen = (await as("requester").get("/categories")).body.map((c: { name: string }) => c.name)
    expect(seen).not.toContain("Laptop")
    expect(seen).not.toContain("Screen")
    expect(seen).toContain("Hardware")
    expect((await as("requester").get("/categories?includeInactive=true")).status).toBe(403)
    expect((await as("admin").get("/categories?includeInactive=true")).body.map((c: { name: string }) => c.name)).toContain("Screen")
  })
})

describe("SLA policies", () => {
  it("agents read them; admins change them, audited; a warning past its target is refused", async () => {
    const policies = await as("agent").get("/sla-policies")
    expect(policies.body).toHaveLength(1)
    const id = policies.body[0].id as string
    expect((await as("agent").patch(`/sla-policies/${id}`, {})).status).toBe(403)

    const targets = { responseTargetMinutes: 20, resolutionTargetMinutes: 480, responseWarningMinutes: 5, resolutionWarningMinutes: 60 }
    expect((await as("admin").patch(`/sla-policies/${id}`, targets)).body).toMatchObject({ responseTargetMinutes: 20 })
    const bad = await as("admin").patch(`/sla-policies/${id}`, { ...targets, responseWarningMinutes: 20 })
    expect(bad.status).toBe(400)
    expect(bad.body.errors[0].path).toBe("responseWarningMinutes")

    const audit = await db.auditLog.findFirstOrThrow({ where: { orgId: ws.orgId, action: "SLA_POLICY_CHANGED" } })
    expect(audit.diff).toMatchObject({ priority: "HIGH", responseTargetMinutes: { from: 30, to: 20 } })
  })
})
