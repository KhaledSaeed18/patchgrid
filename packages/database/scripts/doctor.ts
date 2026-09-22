/**
 * Checks that the local database is wired the way the design requires, and says
 * exactly what is wrong when it is not.
 *
 * These are invariants, not preferences — each one is a way the isolation model
 * fails silently if it drifts. The tenancy suite (M1) asserts the same things in
 * CI; this exists so a developer finds out at setup time rather than from a
 * confusing error three hours later.
 *
 *   pnpm db:doctor
 */
import path from "node:path"
import process from "node:process"

import { createPrismaClient, assertAppRoleCannotBypassRls } from "../src/index.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

type Check = { name: string; run: () => Promise<string> }

const appUrl = process.env.DATABASE_URL
const migrationUrl = process.env.DATABASE_MIGRATION_URL

if (appUrl === undefined || migrationUrl === undefined) {
  console.error("DATABASE_URL and DATABASE_MIGRATION_URL are required. Copy .env.example to .env.")
  process.exit(1)
}

const app = createPrismaClient({ connectionString: appUrl })

const checks: Check[] = [
  {
    name: "app and migration URLs differ",
    run: async () => {
      if (appUrl === migrationUrl) {
        throw new Error(
          "DATABASE_URL equals DATABASE_MIGRATION_URL — the app would run as the migration role, " +
            "which holds BYPASSRLS and ignores every tenant policy",
        )
      }
      return "the application never connects as the migration role"
    },
  },
  {
    name: "app role cannot bypass RLS",
    run: async () => {
      await assertAppRoleCannotBypassRls(app)
      const [role] = await app.$queryRawUnsafe<{ current_user: string }[]>(
        "SELECT current_user",
      )
      return `connected as ${role?.current_user ?? "?"}, no superuser, no BYPASSRLS`
    },
  },
  {
    name: "app role cannot create tables",
    run: async () => {
      const [row] = await app.$queryRawUnsafe<{ has: boolean }[]>(
        "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS has",
      )
      if (row?.has !== false) throw new Error("app role holds CREATE on schema public")
      return "no CREATE on schema public — migrations are the owner's job alone"
    },
  },
  {
    name: "default privileges are configured",
    run: async () => {
      const rows = await app.$queryRawUnsafe<{ defaclacl: string }[]>(
        `SELECT array_to_string(d.defaclacl, ',') AS defaclacl
           FROM pg_default_acl d
           JOIN pg_roles r ON r.oid = d.defaclrole
          WHERE r.rolname = 'patchgrid_owner' AND d.defaclobjtype = 'r'`,
      )
      const acl = rows[0]?.defaclacl ?? ""
      if (!acl.includes("patchgrid_app")) {
        throw new Error(
          "ALTER DEFAULT PRIVILEGES is not set for patchgrid_owner — every table a future " +
            "migration adds will be unreadable by the application. Run: pnpm db:bootstrap",
        )
      }
      return "tables created by future migrations will be readable by the app role"
    },
  },
  {
    name: "pgvector is installed",
    run: async () => {
      const [row] = await app.$queryRawUnsafe<{ extversion: string }[]>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      )
      if (row === undefined) throw new Error("pgvector is not installed. Run: pnpm db:bootstrap")
      return `vector ${row.extversion}`
    },
  },
  {
    name: "session time zone is UTC",
    run: async () => {
      // `SHOW TimeZone` returns a column literally named "TimeZone"; aliasing it
      // is the difference between asserting and printing a question mark.
      const [row] = await app.$queryRawUnsafe<{ tz: string }[]>(
        "SELECT current_setting('TimeZone') AS tz",
      )
      const tz = row?.tz
      if (tz !== "UTC") {
        throw new Error(
          `session TimeZone is ${tz ?? "unreadable"}, expected UTC. Every SLA comparison ` +
            "would depend on the connection's zone (ADR-0023).",
        )
      }
      return "UTC"
    },
  },
]

let failed = 0
for (const check of checks) {
  try {
    const detail = await check.run()
    console.log(` PASS  ${check.name.padEnd(38)} ${detail}`)
  } catch (error) {
    failed += 1
    console.log(` FAIL  ${check.name.padEnd(38)} ${error instanceof Error ? error.message : error}`)
  }
}
await app.$disconnect()

console.log(
  failed === 0
    ? `\n${checks.length}/${checks.length} checks passed`
    : `\n${checks.length - failed}/${checks.length} passed, ${failed} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
