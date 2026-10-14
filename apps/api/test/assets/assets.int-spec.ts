/**
 * Assets end to end (DOMAIN.md §9.3): the register an agent keeps, the slice
 * a requester sees, a ticket raised about an asset, the asset's history as
 * the ordinary ticket list scoped per reader, and a delete that refuses to
 * erase that history.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "rita" | "rosa" | "agent" | "admin"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let laptop = ""
let spare = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "cmdb", people: { rita: "REQUESTER", rosa: "REQUESTER", agent: "AGENT", admin: "ADMIN" } })
})

afterAll(async () => {
  await db.ticketAsset.deleteMany({ where: { orgId: ws.orgId } })
  await db.asset.deleteMany({ where: { orgId: ws.orgId } })
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.comment.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticket.deleteMany({ where: { orgId: ws.orgId } })
  await db.ticketCounter.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
const incident = { type: "INCIDENT", title: "Screen flickers", description: "x", impact: "LOW", urgency: "LOW" } as const

describe("the register", () => {
  it("is kept by agents: create, a serial unique per org, and an edit", async () => {
    const created = await as("agent").post("/assets", {
      name: "ThinkPad T14",
      type: "LAPTOP",
      status: "IN_USE",
      serialNumber: "PF-1001",
      ownerMembershipId: ws.people.rita.membershipId,
      purchaseDate: "2025-01-10",
      warrantyExpiresAt: "2028-01-10",
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body).toMatchObject({ owner: { membershipId: ws.people.rita.membershipId }, purchaseDate: "2025-01-10", ticketCount: 0 })
    laptop = created.body.id as string

    expect((await as("agent").post("/assets", { name: "Other", type: "LAPTOP", serialNumber: "PF-1001" })).status).toBe(409)
    spare = (await as("agent").post("/assets", { name: "Dell U2723QE", type: "MONITOR" })).body.id as string

    const edited = await as("agent").patch(`/assets/${spare}`, { status: "IN_REPAIR", notes: "Dead pixel" })
    expect(edited.body).toMatchObject({ status: "IN_REPAIR", notes: "Dead pixel" })
    expect((await as("rita").post("/assets", { name: "Mine", type: "PHONE" })).status).toBe(403)
  })

  it("shows a requester only what they hold, and 404s the rest", async () => {
    const mine = await as("rita").get("/assets")
    expect((mine.body.items as { id: string }[]).map((a) => a.id)).toEqual([laptop])
    expect((await as("rita").get(`/assets?ownerMembershipId=${ws.people.rosa.membershipId}`)).body.items).toEqual([])
    expect((await as("rita").get(`/assets/${laptop}`)).body.capabilities).toEqual({ canEdit: false, canDelete: false })
    expect((await as("rosa").get(`/assets/${laptop}`)).status).toBe(404)
    expect((await as("rita").get(`/assets/${spare}`)).status).toBe(404)
    expect((await as("agent").get("/assets?q=dell")).body.items).toHaveLength(1)
  })
})

describe("tickets about an asset", () => {
  it("lets a requester name only their own asset when raising a ticket", async () => {
    expect((await as("rosa").post("/tickets", { ...incident, assetIds: [laptop] })).status).toBe(400)
    const raised = await as("rita").post("/tickets", { ...incident, assetIds: [laptop] })
    expect(raised.status, JSON.stringify(raised.body)).toBe(201)
    expect(raised.body.assets).toEqual([{ id: laptop, name: "ThinkPad T14", type: "LAPTOP", status: "IN_USE" }])
  })

  it("lets an agent link and unlink, and a requester neither", async () => {
    const other = await as("rosa").post("/tickets", incident)
    const id = other.body.id as string
    expect((await as("rosa").put(`/tickets/${id}/assets/${spare}`)).status).toBe(403)
    expect((await as("agent").put(`/tickets/${id}/assets/${spare}`)).status).toBe(204)
    expect((await as("agent").put(`/tickets/${id}/assets/${spare}`)).status).toBe(204)
    expect((await as("agent").put(`/tickets/${id}/assets/${laptop}`)).status).toBe(204)
    // Rosa sees the assets on her ticket by name, though she could not open either.
    expect(((await as("rosa").get(`/tickets/${id}`)).body.assets as { id: string }[]).map((a) => a.id).toSorted()).toEqual([laptop, spare].toSorted())
    expect((await as("agent").delete(`/tickets/${id}/assets/${spare}`)).status).toBe(204)
    expect((await as("agent").delete(`/tickets/${id}/assets/${spare}`)).status).toBe(404)
    const trail = await db.auditLog.findMany({ where: { orgId: ws.orgId, entityId: id, action: { in: ["TICKET_ASSET_LINKED", "TICKET_ASSET_UNLINKED"] } } })
    expect(trail.map((t) => t.action).toSorted()).toEqual(["TICKET_ASSET_LINKED", "TICKET_ASSET_LINKED", "TICKET_ASSET_UNLINKED"])
  })

  it("lists an asset's history as each reader may see it, in any status", async () => {
    const history = (who: Who) => as(who).get(`/tickets?view=all&assetId=${laptop}`)
    expect((await history("agent")).body.items).toHaveLength(2)
    // Rita owns the laptop but did not raise Rosa's ticket about it.
    expect((await history("rita")).body.items).toHaveLength(1)
    expect((await as("agent").get(`/assets/${laptop}`)).body.ticketCount).toBe(2)
  })

  it("keeps an asset a ticket names: delete is refused, retiring is not", async () => {
    expect((await as("agent").delete(`/assets/${laptop}`)).status).toBe(403)
    expect((await as("admin").delete(`/assets/${laptop}`)).status).toBe(409)
    expect((await as("admin").patch(`/assets/${laptop}`, { status: "RETIRED" })).status).toBe(200)
    const unused = (await as("agent").post("/assets", { name: "Typo", type: "OTHER" })).body.id as string
    expect((await as("admin").delete(`/assets/${unused}`)).status).toBe(204)
    expect((await as("admin").get(`/assets/${unused}`)).status).toBe(404)
  })
})
