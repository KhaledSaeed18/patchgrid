/**
 * Audit retention by plan (ADR-0028, ADR-0034): a FREE workspace keeps two
 * years, through the retention sweep's per-tenant delete; a PRO one keeps the
 * archival's seven, so the sweep leaves it alone. The delete is raw, on a
 * partitioned table under RLS, so it is run against the real one.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import type { Job } from "bullmq"
import process from "node:process"
import { afterAll, beforeAll, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { RetentionSweepProcessor } from "../../src/jobs/maintenance/retention-sweep"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { seedWorkspace, type Workspace } from "../support/workspace"

let db: PrismaClient
let app: INestApplication
let free: Workspace<"owner">
let pro: Workspace<"owner">

const YEAR_MS = 365 * 24 * 60 * 60_000
const threeYearsAgo = new Date(Date.now() - 3 * YEAR_MS)
const oneYearAgo = new Date(Date.now() - YEAR_MS)

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
  free = await seedWorkspace(app, db, { prefix: "auditfree", people: { owner: "OWNER" } })
  pro = await seedWorkspace(app, db, { prefix: "auditpro", people: { owner: "OWNER" } })
  await db.organization.update({ where: { id: pro.orgId }, data: { plan: "PRO" } })
  for (const at of [threeYearsAgo, oneYearAgo])
    await db.$executeRawUnsafe(`SELECT ensure_audit_log_partition('${at.toISOString()}'::timestamptz)`)
  for (const ws of [free, pro]) {
    await db.auditLog.createMany({
      data: [threeYearsAgo, oneYearAgo].map((createdAt) => ({
        orgId: ws.orgId,
        action: "TEAM_UPDATED",
        entityType: "Team",
        entityId: ws.orgId,
        actorKind: "SYSTEM" as const,
        diff: {},
        createdAt,
      })),
    })
  }
})

afterAll(async () => {
  for (const ws of [free, pro]) {
    if (ws === undefined) continue
    await db.auditLog.deleteMany({ where: { orgId: ws.orgId } })
    await ws.cleanup()
  }
  await app?.close()
  await db.$disconnect()
  delete process.env.WORKER_MODE
})

const sweep = (orgId: string) =>
  app.get(RetentionSweepProcessor).process({ id: `retention/${orgId}`, data: { orgId, tick: 1 } } as unknown as Job)
const auditSince = (orgId: string) =>
  db.auditLog.findMany({ where: { orgId, createdAt: { lt: new Date(Date.now() - YEAR_MS / 2) } }, select: { createdAt: true } })

it("trims a FREE workspace past two years, keeps its younger history, and touches no one else's", async () => {
  expect((await sweep(free.orgId)).audit).toBe(1)
  expect((await auditSince(free.orgId)).map((r) => r.createdAt.getTime())).toEqual([oneYearAgo.getTime()])
  expect(await auditSince(pro.orgId)).toHaveLength(2)
})

it("leaves a PRO workspace's history to the seven-year archival", async () => {
  expect((await sweep(pro.orgId)).audit).toBe(0)
  expect(await auditSince(pro.orgId)).toHaveLength(2)
})
