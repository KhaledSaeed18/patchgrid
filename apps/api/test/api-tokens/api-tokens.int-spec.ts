/**
 * API tokens end to end (ADR-0021, ADR-0042): an admin mints one, a machine
 * uses it with nothing but the bearer header, it can do exactly its role ∩ its
 * scopes — attributed to its own service account — and a revocation holds on
 * the very next request.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { API_TOKEN_PATTERN } from "@patchgrid/contracts"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

type Who = "owner" | "admin" | "agent" | "requester"
type Minted = { id: string; secret: string; membershipId: string }

let db: PrismaClient
let app: INestApplication
let ws: Workspace<Who>
let other: Workspace<"owner">
let writer: Minted = { id: "", secret: "", membershipId: "" }
let reader: Minted = { id: "", secret: "", membershipId: "" }
let ticketId = ""

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  ws = await seedWorkspace(app, db, { prefix: "tokens", people: { owner: "OWNER", admin: "ADMIN", agent: "AGENT", requester: "REQUESTER" } })
  other = await seedWorkspace(app, db, { prefix: "tokens-other", people: { owner: "OWNER" } })
  const ticket = { type: "INCIDENT", title: "VPN drops", description: "x", impact: "LOW", urgency: "LOW" }
  ticketId = (await as("requester").post("/tickets", ticket)).body.id as string
  await as("agent").post(`/tickets/${ticketId}/comments`, { body: "Concentrator lease, between us.", visibility: "INTERNAL" })
})

afterAll(async () => {
  for (const w of [ws, other]) {
    if (w === undefined) continue
    await db.apiToken.deleteMany({ where: { orgId: w.orgId } })
    await db.apiTokenIndex.deleteMany({ where: { orgId: w.orgId } })
    await db.notification.deleteMany({ where: { orgId: w.orgId } })
    await db.ticketWatcher.deleteMany({ where: { orgId: w.orgId } })
    await db.comment.deleteMany({ where: { orgId: w.orgId } })
    await db.ticket.deleteMany({ where: { orgId: w.orgId } })
    await db.ticketCounter.deleteMany({ where: { orgId: w.orgId } })
    await w.cleanup()
  }
  await app?.close()
  await db.$disconnect()
})

const as = (who: Who) => browser(app, ws.origin, ws.people[who].access)
/** A machine: no cookies, no Origin, no X-Requested-With — the header is everything. */
const machine = (secret: string) => {
  const http = () => request(app.getHttpServer())
  const auth = { Authorization: `Bearer ${secret}` }
  return {
    get: (path: string) => http().get(`/api/v1${path}`).set(auth),
    post: (path: string, body: object = {}) => http().post(`/api/v1${path}`).set(auth).set("Content-Type", "application/json").send(body),
    put: (path: string) => http().put(`/api/v1${path}`).set(auth),
  }
}
const mint = async (body: object): Promise<Minted> => {
  const created = await as("admin").post("/org/api-tokens", body)
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  return { id: created.body.token.id as string, secret: created.body.secret as string, membershipId: created.body.token.membershipId as string }
}

describe("minting", () => {
  it("lets an admin mint a token and shows its secret exactly once", async () => {
    writer = await mint({ name: "Monitoring", role: "AGENT", scopes: ["tickets:read", "tickets:write"], expiresInDays: 30 })
    expect(writer.secret).toMatch(API_TOKEN_PATTERN)
    reader = await mint({ name: "Dashboard", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })

    const listed = await as("owner").get("/org/api-tokens")
    expect(listed.body).toEqual([
      expect.objectContaining({ id: reader.id, name: "Dashboard", status: "ACTIVE", expiresAt: null }),
      expect.objectContaining({ id: writer.id, prefix: API_TOKEN_PATTERN.exec(writer.secret)?.[1], role: "AGENT", lastUsedAt: null }),
    ])
    expect(JSON.stringify(listed.body)).not.toContain(writer.secret.split("_")[2])
  })

  it("is an admin's and an owner's only, and refuses a role or scope a token may not have", async () => {
    const body = { name: "x", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null }
    expect((await as("agent").get("/org/api-tokens")).status).toBe(403)
    expect((await as("agent").post("/org/api-tokens", body)).status).toBe(403)
    expect((await as("admin").post("/org/api-tokens", { ...body, role: "ADMIN" })).status).toBe(400)
    expect((await as("admin").post("/org/api-tokens", { ...body, scopes: ["webhooks:write"] })).status).toBe(400)
  })

  it("puts the service account in the member list, marked, and keeps member admin's hands off it", async () => {
    const members = await as("owner").get("/members?limit=100")
    expect(members.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: writer.membershipId, kind: "SERVICE_ACCOUNT", displayName: "Monitoring" })]),
    )
    expect((await as("owner").patch(`/members/${writer.membershipId}/role`, { role: "ADMIN" })).status).toBe(409)
    expect((await as("owner").post(`/members/${writer.membershipId}/disable`)).status).toBe(409)
  })
})

describe("using a token", () => {
  it("reads and writes as its own service account, with source API and actor kind SERVICE", async () => {
    expect((await machine(writer.secret).get("/tickets")).status).toBe(200)
    const created = await machine(writer.secret).post("/tickets", {
      type: "INCIDENT",
      title: "Disk 92% on db-1",
      description: "From monitoring",
      impact: "MEDIUM",
      urgency: "HIGH",
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body).toMatchObject({ source: "API", requester: { membershipId: writer.membershipId, displayName: "Monitoring" } })
    const audit = await db.auditLog.findFirst({ where: { orgId: ws.orgId, entityId: created.body.id as string, action: "TICKET_CREATED" } })
    expect(audit).toMatchObject({ actorKind: "SERVICE", actorMembershipId: writer.membershipId })
    const used = await as("admin").get("/org/api-tokens")
    expect(used.body.find((t: { id: string }) => t.id === writer.id)?.lastUsedAt).not.toBeNull()
  })

  it("gets exactly role ∩ scopes: no write without tickets:write, no internal notes without comments:internal, no members ever", async () => {
    const ticket = { type: "INCIDENT", title: "x", description: "x", impact: "LOW", urgency: "LOW" }
    expect((await machine(reader.secret).post("/tickets", ticket)).status).toBe(403)
    const comments = await machine(reader.secret).get(`/tickets/${ticketId}/comments`)
    expect(comments.status).toBe(200)
    expect(JSON.stringify(comments.body)).not.toContain("between us")
    expect((await machine(writer.secret).get("/members")).status).toBe(403)
    expect((await machine(writer.secret).get("/org/api-tokens")).status).toBe(403)
    expect((await machine(writer.secret).post("/org/api-tokens", { name: "x", role: "AGENT", scopes: ["tickets:read"], expiresInDays: null })).status).toBe(403)
  })

  it("never becomes a watcher or an assignee: there is no one behind it to tell", async () => {
    expect((await machine(writer.secret).put(`/tickets/${ticketId}/watchers/${writer.membershipId}`)).status).toBe(400)
    const ticket = await as("agent").get(`/tickets/${ticketId}`)
    const assign = { action: "assign", version: ticket.body.version as number, assigneeMembershipId: writer.membershipId }
    expect((await as("admin").post(`/tickets/${ticketId}/transitions`, assign)).status).toBe(400)
  })

  it("is refused with a wrong secret, and against another workspace's origin", async () => {
    const [, prefix] = API_TOKEN_PATTERN.exec(writer.secret) ?? []
    expect((await machine(`pg_${prefix ?? ""}_${"A".repeat(43)}`).get("/tickets")).status).toBe(401)
    expect((await machine(writer.secret).get("/tickets").set("Origin", other.origin)).status).toBe(403)
  })
})

describe("revoking", () => {
  it("holds on the next request, disables the service account, and happens once", async () => {
    const revoked = await as("owner").post(`/org/api-tokens/${writer.id}/revoke`)
    expect(revoked.status).toBe(200)
    expect(revoked.body).toMatchObject({ status: "REVOKED" })
    expect((await machine(writer.secret).get("/tickets")).status).toBe(401)
    expect((await as("owner").post(`/org/api-tokens/${writer.id}/revoke`)).status).toBe(409)
    expect((await as("owner").get(`/members/${writer.membershipId}`)).body).toMatchObject({ status: "DISABLED", kind: "SERVICE_ACCOUNT" })
    const audit = await db.auditLog.findMany({ where: { orgId: ws.orgId, entityType: "ApiToken" }, orderBy: { createdAt: "asc" } })
    expect(audit.map((a) => a.action)).toEqual(["TOKEN_CREATED", "TOKEN_CREATED", "TOKEN_REVOKED"])
    // The other token is untouched.
    expect((await machine(reader.secret).get("/tickets")).status).toBe(200)
  })
})
