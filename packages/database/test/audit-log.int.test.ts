/**
 * The partitioned audit log under RLS (ADR-0034), as patchgrid_app.
 *
 * Proves the three things the parent's policy alone would not: the app role
 * can make a month partition without holding CREATE, every partition is fenced
 * by its own forced policy — so naming a partition directly leaks nothing — and
 * a month with no partition refuses the insert loudly rather than parking rows
 * somewhere a later partition cannot be created over.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

const PARTITION = "AuditLog_2099_03"
const IN_PARTITION = "2099-03-15T12:00:00Z"
const suffix = randomUUID().slice(0, 8)

let owner: pg.Client
let app: pg.Client
const orgs = { acme: "", globex: "" }

/** One statement in a transaction scoped to `orgId` — the shape the client extension produces. */
async function asTenant<T extends pg.QueryResultRow>(
  orgId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await app.query("BEGIN")
  try {
    if (orgId !== null) await app.query("SELECT set_config('app.current_org_id', $1, true)", [orgId])
    const result = await app.query<T>(sql, params)
    await app.query("COMMIT")
    return result.rows
  } catch (error) {
    await app.query("ROLLBACK")
    throw error
  }
}

const insert = (orgId: string, at: string) =>
  asTenant(
    orgId,
    `INSERT INTO "AuditLog" (id, "orgId", "entityType", "entityId", action, "actorKind", "createdAt")
     VALUES ($1, $2, 'Organization', $2, 'PROBE', 'SYSTEM', $3)`,
    [randomUUID(), orgId, at],
  )

beforeAll(async () => {
  owner = new pg.Client({ connectionString: requireEnv("DATABASE_MIGRATION_URL") })
  app = new pg.Client({ connectionString: requireEnv("DATABASE_URL") })
  await Promise.all([owner.connect(), app.connect()])
  for (const name of ["acme", "globex"] as const) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, $2, $2, now()) RETURNING id`,
      [randomUUID(), `${name}-${suffix}`],
    )
    orgs[name] = rows[0]?.id ?? ""
  }
})

afterAll(async () => {
  await owner.query(`DROP TABLE IF EXISTS "${PARTITION}"`)
  await owner.query(`DELETE FROM "AuditLog" WHERE "orgId" = ANY($1)`, [Object.values(orgs)])
  await owner.query(`DELETE FROM "Organization" WHERE id = ANY($1)`, [Object.values(orgs)])
  await Promise.all([owner.end(), app.end()])
})

describe("audit-log partitions", () => {
  it("the app role makes a month partition through the function, idempotently", async () => {
    const first = await app.query<{ name: string }>("SELECT ensure_audit_log_partition($1) AS name", [IN_PARTITION])
    const again = await app.query<{ name: string }>("SELECT ensure_audit_log_partition($1) AS name", [
      "2099-03-31T23:59:59Z",
    ])
    expect(first.rows[0]?.name).toBe(PARTITION)
    expect(again.rows[0]?.name).toBe(PARTITION)
  })

  it("still cannot create anything else", async () => {
    await expect(app.query(`CREATE TABLE "Probe_${suffix}" (id int)`)).rejects.toThrow(/permission denied/)
  })

  it("the new partition carries forced RLS and exactly the template policy", async () => {
    const { rows } = await owner.query<{ forced: boolean; enabled: boolean; policies: string }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname)::text AS policies
         FROM pg_class c WHERE c.relname = $1`,
      [PARTITION],
    )
    expect(rows[0]).toEqual({ enabled: true, forced: true, policies: "1" })
  })

  it("a row lands in its month and is invisible to another tenant — through the parent or the partition", async () => {
    await insert(orgs.acme, IN_PARTITION)

    const own = await asTenant(orgs.acme, `SELECT tableoid::regclass::text AS part FROM "AuditLog" WHERE "orgId" = $1`, [
      orgs.acme,
    ])
    expect(own).toEqual([{ part: `"${PARTITION}"` }])

    for (const sql of [`SELECT id FROM "AuditLog"`, `SELECT id FROM "${PARTITION}"`]) {
      expect(await asTenant(orgs.globex, sql)).toEqual([])
      expect(await asTenant(null, sql)).toEqual([])
    }
  })

  it("refuses to write another tenant's row into a partition named directly", async () => {
    await expect(
      asTenant(
        orgs.globex,
        `INSERT INTO "${PARTITION}" (id, "orgId", "entityType", "entityId", action, "actorKind", "createdAt")
         VALUES ($1, $2, 'Organization', $2, 'PROBE', 'SYSTEM', $3)`,
        [randomUUID(), orgs.acme, IN_PARTITION],
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it("a month with no partition refuses the insert — there is no default partition", async () => {
    await expect(insert(orgs.acme, "2098-01-15T00:00:00Z")).rejects.toThrow(/no partition of relation/)
  })
})
