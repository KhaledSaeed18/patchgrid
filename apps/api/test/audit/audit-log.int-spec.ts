/**
 * The audit log through the booted AppModule (ADR-0034): boot leaves the
 * current and next month's partitions in place, and an audit row written in a
 * transaction lands under RLS with its actor — or not at all if the
 * transaction rolls back.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { createPrismaClient, type PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { AuditService } from "../../src/audit/audit.service"
import { CLOCK, FixedClock } from "../../src/common/clock/clock"
import { MAIL_PROVIDER } from "../../src/mail/mail-provider"
import { RecordingMailProvider } from "../../src/mail/providers/recording-mail.provider"
import { runAsTenant } from "../../src/platform/run-as-tenant"
import { PrismaService } from "../../src/prisma/prisma.service"

// Far enough ahead that the partitions this boot creates are its own to drop.
const NOW = new Date("2099-07-10T09:00:00Z")
const PARTITIONS = ["AuditLog_2099_07", "AuditLog_2099_08"]
const suffix = randomUUID().slice(0, 8)

let owner: PrismaClient
let app: INestApplication
let orgId = ""

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  orgId = (await owner.organization.create({ data: { name: "Audit", slug: `audit-${suffix}` } })).id
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(new RecordingMailProvider())
    .overrideProvider(CLOCK)
    .useValue(new FixedClock(NOW))
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  await app.init()
})

afterAll(async () => {
  await app.close()
  await owner.auditLog.deleteMany({ where: { orgId } })
  for (const name of PARTITIONS) await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`)
  await owner.organization.delete({ where: { id: orgId } })
  await owner.$disconnect()
})

describe("the audit log", () => {
  it("boot ensures this month's partition and next month's", async () => {
    const found = await owner.$queryRaw<{ name: string | null }[]>`
      SELECT to_regclass(format('public.%I', n))::text AS name FROM unnest(${PARTITIONS}::text[]) AS n`
    expect(found.map((r) => r.name)).toEqual(PARTITIONS.map((p) => `"${p}"`))
  })

  it("writes inside the change's transaction, under the tenant, as SYSTEM with no actor", async () => {
    const audit = app.get(AuditService)
    const prisma = app.get(PrismaService)
    await runAsTenant(orgId, { actor: "test", reason: "audit spec" }, () =>
      prisma.transaction(() =>
        audit.record(orgId, [{ action: "ORG_SETTINGS_UPDATED", entityType: "Organization", entityId: orgId, diff: { name: { from: "A", to: "B" } } }]),
      ),
    )
    const rows = await owner.auditLog.findMany({ where: { orgId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "ORG_SETTINGS_UPDATED", actorKind: "SYSTEM", actorMembershipId: null, createdAt: NOW })
    expect(rows[0]?.diff).toEqual({ name: { from: "A", to: "B" } })
  })

  it("rolls back with a change that fails", async () => {
    const audit = app.get(AuditService)
    const prisma = app.get(PrismaService)
    await expect(
      runAsTenant(orgId, { actor: "test", reason: "audit spec" }, () =>
        prisma.transaction(async () => {
          await audit.record(orgId, [{ action: "ORG_SLUG_CHANGED", entityType: "Organization", entityId: orgId }])
          throw new Error("the change failed")
        }),
      ),
    ).rejects.toThrow("the change failed")
    expect(await owner.auditLog.count({ where: { orgId, action: "ORG_SLUG_CHANGED" } })).toBe(0)
  })
})
