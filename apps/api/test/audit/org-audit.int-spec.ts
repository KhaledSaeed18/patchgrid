/**
 * `GET /org/audit` through the booted app: filters by actor, action and date,
 * keyset paging that neither skips nor repeats a row, and another tenant's
 * rows — written into the same monthly partition — never appearing.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let acme: Workspace<"admin" | "agent">
let globex: Workspace<"owner">
const base = Date.now() - 60 * 60_000

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()
  acme = await seedWorkspace(app, db, { prefix: "audit", people: { admin: "ADMIN", agent: "AGENT" } })
  globex = await seedWorkspace(app, db, { prefix: "auditx", people: { owner: "OWNER" } })

  // Seven acme rows a minute apart — five by the admin, two by the agent — and globex rows among them.
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: randomUUID(),
    orgId: acme.orgId,
    entityType: "Membership",
    entityId: acme.people.agent.membershipId,
    action: i % 2 === 0 ? "MEMBER_DISABLED" : "MEMBER_ENABLED",
    actorKind: "MEMBER" as const,
    actorMembershipId: i < 5 ? acme.people.admin.membershipId : acme.people.agent.membershipId,
    createdAt: new Date(base + i * 60_000),
  }))
  await db.auditLog.createMany({ data: rows })
  await db.auditLog.createMany({
    data: [0, 1, 2].map((i) => ({
      id: randomUUID(),
      orgId: globex.orgId,
      entityType: "Organization",
      entityId: globex.orgId,
      action: "MEMBER_DISABLED",
      actorKind: "SYSTEM" as const,
      createdAt: new Date(base + i * 60_000 + 30_000),
    })),
  })
})

afterAll(async () => {
  await globex?.cleanup()
  await acme?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const admin = () => browser(app, acme.origin, acme.people.admin.access)

describe("GET /org/audit", () => {
  it("is an admin's view", async () => {
    expect((await browser(app, acme.origin, acme.people.agent.access).get("/org/audit")).status).toBe(403)
  })

  it("pages newest first through every row exactly once, and only this tenant's", async () => {
    const seen: string[] = []
    let cursor: string | null = ""
    while (cursor !== null) {
      const page = await admin().get(`/org/audit?limit=3${cursor === "" ? "" : `&cursor=${cursor}`}`)
      expect(page.status).toBe(200)
      seen.push(...page.body.items.map((e: { createdAt: string }) => e.createdAt))
      cursor = page.body.nextCursor as string | null
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    expect(seen).toEqual(seen.toSorted().toReversed())
  })

  it("filters by actor, by action, and by date range", async () => {
    const byAgent = await admin().get(`/org/audit?actorMembershipId=${acme.people.agent.membershipId}`)
    expect(byAgent.body.items).toHaveLength(2)
    expect(byAgent.body.items[0].actor).toEqual({ kind: "MEMBER", membershipId: acme.people.agent.membershipId, displayName: "agent" })

    expect((await admin().get("/org/audit?action=MEMBER_ENABLED")).body.items).toHaveLength(3)

    const from = new Date(base + 2 * 60_000).toISOString()
    const to = new Date(base + 4 * 60_000).toISOString()
    expect((await admin().get(`/org/audit?from=${from}&to=${to}`)).body.items).toHaveLength(2)
    expect((await admin().get(`/org/audit?from=${to}&to=${from}`)).status).toBe(400)
  })
})
