/**
 * A plan limit reached tells the workspace's admins and owners (DOMAIN.md
 * §8): the promotion that takes the last agent seat writes the event in its
 * own transaction, and the `notify` consumer gives each steward one inbox row,
 * folded per metric and period. A promotion refused at the limit tells nobody
 * a second time. No worker runs; the spec drains by hand.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import process from "node:process"
import { afterAll, beforeAll, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { EventRelay } from "../../src/events/relay"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { browser, seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let ws: Workspace<"owner" | "admin" | "rita" | "rosa">

beforeAll(async () => {
  process.env.WORKER_MODE = "api"
  db = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  // FREE: three seats. The owner and the admin hold two.
  ws = await seedWorkspace(app, db, { prefix: "limit", people: { owner: "OWNER", admin: "ADMIN", rita: "REQUESTER", rosa: "REQUESTER" } })
})

afterAll(async () => {
  await db.notification.deleteMany({ where: { orgId: ws.orgId } })
  await db.eventConsumer.deleteMany({ where: { orgId: ws.orgId } })
  await db.outboxEvent.deleteMany({ where: { orgId: ws.orgId } })
  await ws?.cleanup()
  await app?.close()
  await db.$disconnect()
  delete process.env.WORKER_MODE
})

const drain = () => runAsTenant(ws.orgId, { actor: "test", reason: "drain notify" }, () => app.get(EventRelay).drain(ws.orgId, "notify"))
const promote = (who: "rita" | "rosa") =>
  browser(app, ws.origin, ws.people.owner.access).patch(`/members/${ws.people[who].membershipId}/role`, { role: "AGENT" })
const limitRows = () =>
  db.notification.findMany({
    where: { orgId: ws.orgId, type: "PLAN_LIMIT_REACHED" },
    select: { membershipId: true, title: true, ticketId: true },
  })

it("tells each steward once when the last seat is taken, and not again for the refusal after it", async () => {
  expect((await promote("rita")).status).toBe(200)
  expect(await db.outboxEvent.count({ where: { orgId: ws.orgId, type: "plan-limit-reached" } })).toBe(1)
  await drain()
  const rows = await limitRows()
  expect(rows.map((r) => r.membershipId).sort()).toEqual([ws.people.owner.membershipId, ws.people.admin.membershipId].sort())
  expect(rows[0]).toMatchObject({ title: "The FREE plan's agent seats are all in use", ticketId: null })

  expect((await promote("rosa")).status).toBe(402)
  expect(await db.outboxEvent.count({ where: { orgId: ws.orgId, type: "plan-limit-reached" } })).toBe(1)
})
