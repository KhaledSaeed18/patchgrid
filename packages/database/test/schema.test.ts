/**
 * Schema assertions — the physical shape of the database, read from the catalogs
 * of a migrated database (ADR-0023 §5, ARCHITECTURE.md §Data model).
 *
 *   pnpm test:schema
 *
 * Each of these is a way tenant isolation fails SILENTLY: a table without a
 * policy returns every tenant's rows; a single-column foreign key lets one
 * tenant's row point at another's; a missing grant ships a table the app cannot
 * read. None of them produces an error until it produces a breach, which is why
 * they are asserted from the catalogs rather than trusted to review.
 *
 * Connects as patchgrid_app on purpose: everything here is readable from the
 * catalogs by the least-privileged role, and a test that needs the owner to see
 * the schema would be checking something the application cannot.
 */
import path from "node:path"
import process from "node:process"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { TENANT_POLICY_NAME } from "../src/rls.ts"
import { PLATFORM_TABLES, TOOLING_TABLES, isTenantOwned } from "../src/table-classes.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

const APP_ROLE = "patchgrid_app"

/**
 * `TENANT_POLICY_EXPRESSION` from src/rls.ts, as PostgreSQL deparses it when it
 * stores the policy — explicit casts added, parentheses normalised. Compared
 * exactly, so a hand-edited policy (a missing NULLIF, a text comparison, an `OR`
 * that lets something through) fails here rather than in production.
 */
const DEPARSED_POLICY =
  `("orgId" = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)`

let db: pg.Client
let tables: string[]
let tenantTables: string[]

async function rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is required — the schema assertions read a migrated database")
  }
  db = new pg.Client({ connectionString: url })
  await db.connect()

  tables = (
    await rows<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    )
  )
    .map((r) => r.relname)
    .filter((t) => !TOOLING_TABLES.has(t))
  tenantTables = tables.filter(isTenantOwned)
})

afterAll(async () => {
  await db.end()
})

describe("table classes", () => {
  it("the database has been migrated", () => {
    expect(tenantTables.length, "no tenant-owned tables — run `pnpm db:migrate` first").toBeGreaterThan(0)
  })

  it("every table on the closed platform list exists", () => {
    // A renamed or dropped platform table would leave a stale name on the list —
    // and a NEW table with that name would silently skip every assertion below.
    const missing = [...PLATFORM_TABLES].filter((t) => !tables.includes(t))
    expect(missing).toEqual([])
  })

  it("every tenant-owned table has a non-null uuid orgId", async () => {
    const found = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'orgId'
          AND udt_name = 'uuid' AND is_nullable = 'NO'`,
    )
    const withOrgId = new Set(found.map((r) => r.table_name))
    expect(tenantTables.filter((t) => !withOrgId.has(t))).toEqual([])
  })
})

describe("1 · row-level security", () => {
  it("every tenant-owned table has RLS enabled AND forced", async () => {
    const found = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [tenantTables],
    )
    // Without FORCE the table owner is exempt — ADR-0015 erratum.
    const bad = found
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity)
      .map((r) => `${r.relname} (enabled=${r.relrowsecurity}, forced=${r.relforcerowsecurity})`)
    expect(bad).toEqual([])
  })

  it("every tenant-owned table carries exactly the template policy, and nothing else", async () => {
    const policies = await rows<{
      tablename: string
      policyname: string
      permissive: string
      cmd: string
      roles: string[] | string
      qual: string | null
      with_check: string | null
    }>(
      `SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
         FROM pg_policies WHERE schemaname = 'public'`,
    )

    const problems: string[] = []
    for (const table of tenantTables) {
      const own = policies.filter((p) => p.tablename === table)
      if (own.length !== 1) {
        // A second PERMISSIVE policy is OR-ed with the first — it can only widen.
        problems.push(`${table}: expected 1 policy, found ${own.length}`)
        continue
      }
      const [p] = own
      if (p === undefined) continue
      if (p.policyname !== TENANT_POLICY_NAME) problems.push(`${table}: policy named ${p.policyname}`)
      if (p.permissive !== "PERMISSIVE" || p.cmd !== "ALL") {
        problems.push(`${table}: ${p.permissive} ${p.cmd}, expected PERMISSIVE ALL`)
      }
      if (p.qual !== DEPARSED_POLICY) problems.push(`${table}: USING is ${p.qual}`)
      if (p.with_check !== DEPARSED_POLICY) problems.push(`${table}: WITH CHECK is ${p.with_check}`)
    }
    expect(problems).toEqual([])
  })
})

describe("2 · composite tenant foreign keys", () => {
  type ForeignKey = { name: string; from: string; to: string; fromCols: string[]; toCols: string[] }

  async function foreignKeys(): Promise<ForeignKey[]> {
    const found = await rows<{ name: string; from: string; to: string; from_cols: string[]; to_cols: string[] }>(
      `SELECT con.conname AS name,
              src.relname AS "from",
              dst.relname AS "to",
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n
                     ORDER BY k.i)::text[] AS from_cols,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n
                     ORDER BY k.i)::text[] AS to_cols
         FROM pg_constraint con
         JOIN pg_class src ON src.oid = con.conrelid
         JOIN pg_class dst ON dst.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = src.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'`,
    )
    return found.map((r) => ({ name: r.name, from: r.from, to: r.to, fromCols: r.from_cols, toCols: r.to_cols }))
  }

  it("every FK between two tenant-owned tables is composite and pairs orgId with orgId", async () => {
    // PostgreSQL runs referential-integrity checks with row security OFF, so a
    // single-column FK lets a correctly-tenanted row point at another tenant's
    // row and no policy objects (ADR-0023).
    const bad = (await foreignKeys())
      .filter((fk) => isTenantOwned(fk.from) && isTenantOwned(fk.to))
      .filter((fk) => {
        const i = fk.fromCols.indexOf("orgId")
        return fk.fromCols.length < 2 || i === -1 || fk.toCols[i] !== "orgId"
      })
      .map((fk) => `${fk.name}: (${fk.fromCols.join(", ")}) → ${fk.to}(${fk.toCols.join(", ")})`)
    expect(bad).toEqual([])
  })

  it("every tenant-owned table references its Organization", async () => {
    const fks = await foreignKeys()
    const anchored = new Set(
      fks
        .filter((fk) => fk.to === "Organization" && fk.fromCols.join() === "orgId" && fk.toCols.join() === "id")
        .map((fk) => fk.from),
    )
    expect(tenantTables.filter((t) => !anchored.has(t))).toEqual([])
  })

  it("every tenant-owned table with an id is a legal composite FK target: unique (orgId, id)", async () => {
    const withId = new Set(
      (
        await rows<{ table_name: string }>(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'id'`,
        )
      ).map((r) => r.table_name),
    )
    const unique = new Set(
      (
        await rows<{ relname: string }>(
          `SELECT t.relname
             FROM pg_index i
             JOIN pg_class t ON t.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND i.indisunique AND i.indpred IS NULL
              AND ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n
                         ORDER BY k.o)::text[] = ARRAY['orgId', 'id']`,
        )
      ).map((r) => r.relname),
    )
    expect(tenantTables.filter((t) => withId.has(t) && !unique.has(t))).toEqual([])
  })
})

describe("3 · timestamps", () => {
  it("there are zero `timestamp without time zone` columns", async () => {
    // Prisma's default DateTime is naive; every SLA comparison would then depend
    // on the connection's TimeZone (ADR-0023 §4).
    const found = await rows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`,
    )
    expect(found.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([])
  })
})

describe("4 · identifiers", () => {
  it("every id and *Id column is uuid", async () => {
    // RLS compares against `current_setting(…)::uuid`; a text id would neither
    // match nor use its index (ADR-0023 §3).
    const found = await rows<{ table_name: string; column_name: string; udt_name: string }>(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (column_name = 'id' OR column_name LIKE '%Id')`,
    )
    const bad = found
      .filter((r) => !TOOLING_TABLES.has(r.table_name) && r.udt_name !== "uuid")
      .map((r) => `${r.table_name}.${r.column_name} is ${r.udt_name}`)
    expect(bad).toEqual([])
  })
})

describe("5 · privileges", () => {
  it(`${APP_ROLE} can read and write every table`, async () => {
    // The missing-GRANT failure mode: a table created without ALTER DEFAULT
    // PRIVILEGES in force is invisible to the app, in one environment only.
    const found = await rows<{ relname: string; missing: string[] }>(
      `SELECT t AS relname,
              ARRAY(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
                     WHERE NOT has_table_privilege($1, format('public.%I', t), p)) AS missing
         FROM unnest($2::text[]) t`,
      [APP_ROLE, tables],
    )
    expect(found.filter((r) => r.missing.length > 0).map((r) => `${r.relname}: ${r.missing.join(", ")}`)).toEqual([])
  })

  it(`${APP_ROLE} owns nothing — ownership would let it disable RLS`, async () => {
    const found = await rows<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = $1`,
      [APP_ROLE],
    )
    expect(found).toEqual([])
  })
})
