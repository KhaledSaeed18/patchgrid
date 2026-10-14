/**
 * The purge (TENANCY.md §3, ADR-0043) against a workspace with a row in every
 * tenant-owned table and objects in both storage prefixes, beside a
 * neighbour with the same: the one past its window is erased to a tombstone,
 * the one inside it — and everything the neighbour owns — is untouched.
 */
import { requireEnv } from "../support/env"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
import { createPrismaClient, isTenantOwned, lookalikeEmails, type Lookalikes, type PrismaClient, removeLookalikes, seedLookalikes } from "@patchgrid/database"
import type { Job } from "bullmq"
import { randomUUID } from "node:crypto"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../../src/app.module"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { OrgPurgeProcessor } from "../../src/jobs/purge/org-purge"
import { OrgPurgeRepository } from "../../src/jobs/purge/repositories/org-purge.repository"
import { StorageService } from "../../src/storage/storage.service"

const DAY = 24 * 60 * 60_000
const suffix = `-${randomUUID().slice(0, 8)}`
const slugs = { acme: `purge-acme${suffix}`, globex: `purge-globex${suffix}` }

let owner: PrismaClient
let app: INestApplication
let seed: Lookalikes
let storage: StorageService
let tables: string[] = []

const job = (orgId: string) => ({ id: `purge/${orgId}`, data: { orgId, tick: 1 } }) as unknown as Job
const count = async (table: string, orgId: string) =>
  (await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "orgId" = $1::uuid`, orgId))[0]?.n ?? 0
const objects = async (prefix: string) => {
  let n = 0
  for (const key of [`${prefix}a.txt`, `${prefix}b/c.txt`]) if ((await storage.size(key)) !== null) n += 1
  return n
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })
  await app.listen(0)
  storage = app.get(StorageService)
  seed = await seedLookalikes(owner, { slugs, emailSuffix: suffix, passwordHash: await app.get(PasswordService).hash("purge suite"), slaTargets: DEFAULT_SLA_TARGETS })
  tables = (
    await owner.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    )
  )
    .map((r) => r.relname)
    .filter((t) => t !== "_prisma_migrations" && isTenantOwned(t))
  // An audit row on each side; the lookalikes seed none.
  for (const org of [seed.acme, seed.globex]) {
    await owner.$executeRawUnsafe(`SELECT ensure_audit_log_partition(now())`)
    await owner.auditLog.create({ data: { orgId: org.id, action: "TEAM_UPDATED", entityType: "Team", entityId: org.id, actorKind: "SYSTEM", diff: {} } })
  }
  for (const org of [seed.acme, seed.globex]) {
    for (const prefix of [`org/${org.id}/`, `staging/org/${org.id}/`]) {
      await storage.put(`${prefix}a.txt`, new TextEncoder().encode("a"), "text/plain")
      await storage.put(`${prefix}b/c.txt`, new TextEncoder().encode("c"), "text/plain")
    }
  }
  // Acme asked 31 days ago — past its window and the hour's grace; Globex 29 days ago.
  for (const [org, days] of [[seed.acme, 31], [seed.globex, 29]] as const) {
    const at = new Date(Date.now() - days * DAY)
    await owner.organization.update({ where: { id: org.id }, data: { status: "PENDING_DELETION", deletionRequestedAt: at } })
    await owner.userOrgIndex.updateMany({ where: { orgId: org.id }, data: { orgStatus: "PENDING_DELETION", orgDeletionRequestedAt: at } })
  }
})

afterAll(async () => {
  const users = await owner.user.findMany({ where: { email: { in: lookalikeEmails(suffix) } }, select: { id: true } })
  if (seed !== undefined) {
    await owner.platformAuditLog.deleteMany({ where: { targetOrgId: { in: [seed.acme.id, seed.globex.id] } } })
    await owner.auditLog.deleteMany({ where: { orgId: { in: [seed.acme.id, seed.globex.id] } } })
    await removeLookalikes(owner, { orgIds: [seed.acme.id, seed.globex.id], userIds: users.map((u) => u.id) })
    for (const org of [seed.acme, seed.globex]) {
      await storage.removePrefix(`org/${org.id}/`)
      await storage.removePrefix(`staging/org/${org.id}/`)
    }
  }
  await app?.close()
  await owner.$disconnect()
})

describe("the purge", () => {
  it("names every tenant-owned table, so a new one cannot outlive its workspace", () => {
    expect(app.get(OrgPurgeRepository).steps.map((s) => s.table).sort()).toEqual([...tables].sort())
  })

  it("leaves a workspace inside its window alone", async () => {
    expect(await app.get(OrgPurgeProcessor).process(job(seed.globex.id))).toBeNull()
    expect((await owner.organization.findUniqueOrThrow({ where: { id: seed.globex.id } })).status).toBe("PENDING_DELETION")
  })

  it("erases one workspace past its window to a tombstone, and nothing of its neighbour's", async () => {
    const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t, seed.globex.id)] as const)))
    for (const t of tables) expect(await count(t, seed.acme.id), `${t} seeded for Acme`).toBeGreaterThan(0)

    const report = await app.get(OrgPurgeProcessor).process(job(seed.acme.id))
    expect(report?.objects).toBe(4)

    for (const t of tables) {
      expect(await count(t, seed.acme.id), `${t} left for Acme`).toBe(0)
      expect(await count(t, seed.globex.id), `${t} for Globex`).toBe(before[t])
    }
    expect(await objects(`org/${seed.acme.id}/`)).toBe(0)
    expect(await objects(`staging/org/${seed.acme.id}/`)).toBe(0)
    expect(await objects(`org/${seed.globex.id}/`)).toBe(2)
    expect(await objects(`staging/org/${seed.globex.id}/`)).toBe(2)

    const tombstone = await owner.organization.findUniqueOrThrow({ where: { id: seed.acme.id } })
    expect(tombstone).toMatchObject({ status: "DELETED", slug: slugs.acme, name: "Deleted workspace", domain: null })
    expect(tombstone.deletedAt).not.toBeNull()
    expect(await owner.userOrgIndex.count({ where: { orgId: seed.acme.id } })).toBe(0)
    expect(await owner.apiTokenIndex.count({ where: { orgId: seed.acme.id } })).toBe(0)
    expect(await owner.userOrgIndex.count({ where: { orgId: seed.globex.id } })).toBeGreaterThan(0)
    expect(await owner.platformAuditLog.findFirst({ where: { targetOrgId: seed.acme.id, action: "PLATFORM_ORG_PURGED" } })).not.toBeNull()
  })

  it("keeps the slug taken forever, and the address unknown", async () => {
    const http = () => request(app.getHttpServer())
    expect((await http().get(`/api/v1/tenants/${slugs.acme}`)).status).toBe(404)
    expect((await http().get(`/api/v1/orgs/slug-available?slug=${slugs.acme}`)).body).toMatchObject({ available: false })
  })

  it("does nothing the second time", async () => {
    expect(await app.get(OrgPurgeProcessor).process(job(seed.acme.id))).toBeNull()
  })
})
