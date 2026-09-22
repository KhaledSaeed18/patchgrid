/**
 * Creates the two application roles, the test database, and the per-database
 * privileges — idempotently, against a volume that already exists.
 *
 * The Compose init script does exactly this when the volume is EMPTY. It only
 * runs then, so a developer who already had a Postgres volume would otherwise
 * hit `permission denied for table …` the first time a migration adds a table,
 * and have no obvious way to recover. Both paths share sql/bootstrap.sql so they
 * cannot drift.
 *
 *   pnpm db:bootstrap
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import { Client } from "pg"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

const superuserUrl = requireEnv("DATABASE_SUPERUSER_URL")
const ownerPassword = requireEnv("PATCHGRID_OWNER_PASSWORD")
const appPassword = requireEnv("PATCHGRID_APP_PASSWORD")
const mainDb = process.env.POSTGRES_DB ?? "patchgrid"
const testDb = process.env.POSTGRES_TEST_DB ?? "patchgrid_test"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} is required. Copy .env.example to .env.`)
  }
  return value
}

/** Identifiers cannot be parameterised; these come from our own env, not user input. */
function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Refusing to use ${JSON.stringify(value)} as an identifier`)
  }
  return `"${value}"`
}

async function connect(url: string, database?: string): Promise<Client> {
  const parsed = new URL(url)
  if (database !== undefined) parsed.pathname = `/${database}`
  const client = new Client({ connectionString: parsed.toString() })
  await client.connect()
  return client
}

async function main(): Promise<void> {
  const bootstrapSql = await readFile(
    path.join(import.meta.dirname, "../sql/bootstrap.sql"),
    "utf8",
  )

  const admin = await connect(superuserUrl, mainDb)
  try {
    // The owner runs migrations and the test harness. It needs BYPASSRLS because
    // FORCE ROW LEVEL SECURITY means owning a table is not enough to read it.
    await ensureRole(admin, "patchgrid_owner", ownerPassword, { bypassRls: true })
    await ensureRole(admin, "patchgrid_app", appPassword, { bypassRls: false })

    // The Compose image creates POSTGRES_DB owned by the superuser. The owner
    // role must own it so `prisma migrate reset` can drop and recreate public.
    await admin.query(
      `ALTER DATABASE ${quoteIdent(mainDb)} OWNER TO ${quoteIdent("patchgrid_owner")}`,
    )

    const exists = await admin.query<{ one: number }>(
      "SELECT 1 AS one FROM pg_database WHERE datname = $1",
      [testDb],
    )
    if (exists.rowCount === 0) {
      await admin.query(
        `CREATE DATABASE ${quoteIdent(testDb)} OWNER ${quoteIdent("patchgrid_owner")}`,
      )
      console.log(`  created database ${testDb}`)
    } else {
      console.log(`  database ${testDb} already present`)
    }
  } finally {
    await admin.end()
  }

  // Privileges and default privileges are per-database, so every database the
  // application touches needs the same treatment.
  for (const database of [mainDb, testDb]) {
    const client = await connect(superuserUrl, database)
    try {
      await client.query(bootstrapSql)
      console.log(`  bootstrapped ${database}`)
    } finally {
      await client.end()
    }
  }

  console.log("bootstrap complete")
}

async function ensureRole(
  client: Client,
  name: string,
  password: string,
  { bypassRls }: { bypassRls: boolean },
): Promise<void> {
  const ident = quoteIdent(name)
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])
  if (existing.rowCount === 0) {
    await client.query(`CREATE ROLE ${ident} LOGIN`)
    console.log(`  created role ${name}`)
  }
  // Stated every run, so a role that drifted is corrected rather than trusted.
  await client.query(
    `ALTER ROLE ${ident} LOGIN ${bypassRls ? "BYPASSRLS" : "NOBYPASSRLS"} PASSWORD ${literal(password)}`,
  )
  console.log(`  role ${name}: bypassrls=${bypassRls}`)
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
