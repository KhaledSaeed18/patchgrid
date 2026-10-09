/**
 * Seats against the real database (TENANCY.md §8): the counter moves with
 * every change that starts or ends a seat, a FREE workspace's last seat goes
 * to exactly one of two simultaneous claimants, and the loser's change rolls
 * back whole.
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

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"owner" | "agent" | "spare1" | "spare2">

beforeAll(async () => {
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.init()
  // Two requesters, so the seeded counter holds the owner and the agent: 2 of FREE's 3.
  ws = await seedWorkspace(app, db, {
    prefix: "seats",
    people: { owner: "OWNER", agent: "AGENT", spare1: "REQUESTER", spare2: "REQUESTER" },
  })
})

afterAll(async () => {
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
})

const owner = () => browser(app, ws.origin, ws.people.owner.access)
const seats = async () =>
  Number(
    (await db.usageCounter.findUniqueOrThrow({ where: { orgId_period_metric: { orgId: ws.orgId, period: "current", metric: "AGENT_SEATS" } } })).value,
  )

describe("agent seats", () => {
  it("reports usage against the plan", async () => {
    const usage = await owner().get("/org/usage")
    expect(usage.body.plan).toBe("FREE")
    expect(usage.body.metrics.find((m: { metric: string }) => m.metric === "AGENT_SEATS")).toMatchObject({ used: 2, limit: 3 })
  })

  it("gives the last seat to exactly one of two simultaneous promotions", async () => {
    const [a, b] = await Promise.all([
      owner().patch(`/members/${ws.people.spare1.membershipId}/role`, { role: "AGENT" }),
      owner().patch(`/members/${ws.people.spare2.membershipId}/role`, { role: "AGENT" }),
    ])
    expect([a.status, b.status].toSorted()).toEqual([200, 402])
    const refused = a.status === 402 ? a : b
    expect(refused.body.type).toContain("plan-limit-reached")
    expect(await seats()).toBe(3)
    expect(await db.membership.count({ where: { orgId: ws.orgId, role: "REQUESTER" } })).toBe(1)
  })

  it("is a 402 to invite an agent with none free, and frees one when an agent is disabled", async () => {
    expect((await owner().post("/invitations", { email: `late-${ws.slug}@probe.test`, role: "AGENT" })).status).toBe(402)
    expect((await owner().post(`/members/${ws.people.agent.membershipId}/disable`)).status).toBe(200)
    expect(await seats()).toBe(2)
    expect((await owner().post("/invitations", { email: `late-${ws.slug}@probe.test`, role: "AGENT" })).status).toBe(201)
  })
})
