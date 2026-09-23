/**
 * The tenant client extension (isolation layer 3) against a real database, as
 * patchgrid_app, so RLS (layer 4) is live underneath it.
 *
 * Two organizations get a team with the SAME name — the lookalike data that
 * makes a leak visible rather than plausible (TENANCY.md §10). Rows are seeded
 * and removed through the owner role, which holds BYPASSRLS.
 *
 * The app client's pool is capped at ONE connection, so every query reuses the
 * connection the previous one used: a tenant setting that outlived its
 * transaction would be observed, not just theorised.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createPrismaClient, type PrismaClient } from "../src/index.ts"
import {
  NoTenantContextError,
  tenantTransaction,
  withTenantIsolation,
  type TenantContext,
  type TenantPrismaClient,
} from "../src/tenant-client.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}

const store = new AsyncLocalStorage<TenantContext>()

/** Await INSIDE the context — the rule the lazy-promise test below proves. */
function asTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ orgId }, async () => await fn())
}

let owner: PrismaClient
let base: PrismaClient
let db: TenantPrismaClient

const suffix = randomUUID().slice(0, 8)
const acme = { id: "", slug: `acme-${suffix}` }
const globex = { id: "", slug: `globex-${suffix}` }

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  base = createPrismaClient({ connectionString: requireEnv("DATABASE_URL"), maxConnections: 1 })
  db = withTenantIsolation(base, () => store.getStore())

  for (const org of [acme, globex]) {
    const created = await owner.organization.create({ data: { name: org.slug, slug: org.slug } })
    org.id = created.id
    await owner.team.create({ data: { orgId: created.id, name: "IT Support" } })
  }
})

afterAll(async () => {
  const orgIds = [acme.id, globex.id].filter((id) => id !== "")
  await owner.team.deleteMany({ where: { orgId: { in: orgIds } } })
  await owner.organization.deleteMany({ where: { id: { in: orgIds } } })
  await Promise.all([owner.$disconnect(), base.$disconnect()])
})

describe("tenant client extension", () => {
  it("throws for a tenant-owned model queried with no tenant context", async () => {
    await expect(db.team.findMany()).rejects.toBeInstanceOf(NoTenantContextError)
  })

  it("returns only the context's rows from a query with no where clause", async () => {
    // No `orgId` filter in the query: the isolation here is RLS, reached
    // through the setting the extension made.
    const teams = await asTenant(acme.id, () => db.team.findMany())
    expect(teams.map((t) => t.orgId)).toEqual([acme.id])

    const other = await asTenant(globex.id, () => db.team.findMany())
    expect(other.map((t) => t.orgId)).toEqual([globex.id])
  })

  it("refuses to write a row into another tenant", async () => {
    await expect(
      asTenant(acme.id, () => db.team.create({ data: { orgId: globex.id, name: "Planted" } })),
    ).rejects.toThrow(/row-level security/)
  })

  it("does not leak the tenant setting past its transaction on a pooled connection", async () => {
    await asTenant(acme.id, () => db.team.findMany())
    // Same single pooled connection, no context, straight past the extension.
    const [row] = await base.$queryRaw<{ org: string | null }[]>`
      SELECT current_setting('app.current_org_id', true) AS org`
    expect(row?.org ?? "").toBe("")
  })

  it("lets platform-class models through with no tenant context", async () => {
    const orgs = await db.organization.findMany({ where: { id: { in: [acme.id, globex.id] } } })
    expect(orgs).toHaveLength(2)
  })

  it("fails closed when the promise is awaited outside the context", async () => {
    // `run(ctx, () => fn())` returns the lazy PrismaPromise un-awaited; the
    // extension runs at await time, after the context has exited.
    const escaped = store.run({ orgId: acme.id }, () => db.team.findMany())
    await expect(escaped).rejects.toBeInstanceOf(NoTenantContextError)
  })

  it("passes through inside a tenant transaction instead of nesting one", async () => {
    const names = await store.run({ orgId: acme.id, inTransaction: true }, async () =>
      await tenantTransaction(db, acme.id, async (tx) => {
        const before = await tx.team.findMany()
        await tx.team.create({ data: { orgId: acme.id, name: `Network ${suffix}` } })
        const after = await tx.team.findMany()
        return { before: before.length, after: after.length, orgs: new Set(after.map((t) => t.orgId)) }
      }),
    )
    expect(names).toEqual({ before: 1, after: 2, orgs: new Set([acme.id]) })
  })
})

describe("the RLS policy underneath", () => {
  it("returns zero rows, rather than raising, for an empty-string tenant setting", async () => {
    // NULLIF in the policy: '' would otherwise be `invalid input syntax for type uuid`.
    const [, rows] = await base.$transaction([
      base.$queryRaw`SELECT set_config('app.current_org_id', '', true)`,
      base.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Team"`,
    ])
    expect(Number(rows[0]?.n)).toBe(0)
  })

  it("returns zero rows to a raw query with no tenant setting at all", async () => {
    // Raw SQL skips the extension entirely (model is undefined), which is why it
    // is banned outside this package — RLS alone still holds.
    const rows = await base.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Team"`
    expect(Number(rows[0]?.n)).toBe(0)
  })
})
