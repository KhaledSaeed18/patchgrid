/**
 * Provisions the database the way a managed Postgres allows (ADR-0059), and
 * idempotently, so it is also the repair for a volume that drifted.
 *
 * Two steps, split by who may run them:
 *
 *  1. The instance. Creates `patchgrid_admin`: LOGIN, CREATEROLE, CREATEDB and
 *     nothing more, the master user of an RDS instance. Only a superuser can
 *     do this, so it runs only when DATABASE_SUPERUSER_URL is set. Locally the
 *     Compose init script has already done it, and on RDS the provider did it
 *     when the instance was made. It also adopts roles an older bootstrap made
 *     as a superuser: their BYPASSRLS is removed and the admin is given the
 *     ADMIN option on them, which it would have had had it made them.
 *  2. Everything else, as the admin, through DATABASE_ADMIN_URL: the owner and
 *     app roles, the databases (owned by the owner), and the per-database
 *     grants in sql/bootstrap.sql, run as the owner itself. Nothing here needs
 *     more than RDS gives, so a privilege the design quietly depended on fails
 *     here and in CI rather than on the day of a real deployment.
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

const ADMIN = "patchgrid_admin"
const OWNER = "patchgrid_owner"
const APP = "patchgrid_app"

const adminUrl = requireEnv("DATABASE_ADMIN_URL")
const superuserUrl = optionalEnv("DATABASE_SUPERUSER_URL")
const ownerPassword = requireEnv("PATCHGRID_OWNER_PASSWORD")
const appPassword = requireEnv("PATCHGRID_APP_PASSWORD")
const mainDb = process.env.POSTGRES_DB ?? "patchgrid"
const testDb = process.env.POSTGRES_TEST_DB ?? "patchgrid_test"
// Prisma's scratch database for `migrate dev`. A deployed environment sets it
// empty: it has no use for one.
const shadowDb = process.env.POSTGRES_SHADOW_DB ?? "patchgrid_shadow"
// The databases the application uses, and is granted on. Comma-separated; a
// deployed environment names only its own (no test database).
const databases = (process.env.BOOTSTRAP_DATABASES ?? `${mainDb},${testDb}`).split(",").filter((name) => name !== "")
const ownedDatabases = [...new Set([...databases, ...(shadowDb === "" ? [] : [shadowDb])])]

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} is required. Copy .env.example to .env.`)
  }
  return value
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

/** Identifiers cannot be parameterised; these come from our own env, not user input. */
function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Refusing to use ${JSON.stringify(value)} as an identifier`)
  }
  return `"${value}"`
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** The same server as `url`, as another role or database. */
function sibling(url: string, changes: { user?: string; password?: string; database?: string }): string {
  const parsed = new URL(url)
  if (changes.user !== undefined) parsed.username = encodeURIComponent(changes.user)
  if (changes.password !== undefined) parsed.password = encodeURIComponent(changes.password)
  if (changes.database !== undefined) parsed.pathname = `/${changes.database}`
  return parsed.toString()
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function roleExists(client: Client, name: string): Promise<boolean> {
  const found = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])
  return found.rowCount !== 0
}

/** Step 1: what the provider does when it makes an instance. */
async function provisionInstance(url: string): Promise<void> {
  const adminPassword = new URL(adminUrl).password
  if (adminPassword === "") throw new Error("DATABASE_ADMIN_URL must carry the admin's password")
  await withClient(url, async (client) => {
    if (!(await roleExists(client, ADMIN))) {
      await client.query(`CREATE ROLE ${quoteIdent(ADMIN)} LOGIN`)
      console.log(`  created role ${ADMIN}`)
    }
    await client.query(
      `ALTER ROLE ${quoteIdent(ADMIN)} LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS NOREPLICATION ` +
        `PASSWORD ${literal(decodeURIComponent(adminPassword))}`,
    )
    console.log(`  role ${ADMIN}: createrole, createdb, no superuser`)

    // Roles a superuser made before ADR-0059. The admin manages them from now
    // on, and the owner's exemption is ownership, not an attribute.
    for (const role of [OWNER, APP]) {
      if (!(await roleExists(client, role))) continue
      await client.query(`ALTER ROLE ${quoteIdent(role)} NOSUPERUSER NOBYPASSRLS`)
      await client.query(`GRANT ${quoteIdent(role)} TO ${quoteIdent(ADMIN)} WITH ADMIN TRUE, INHERIT FALSE, SET TRUE`)
      console.log(`  adopted role ${role}`)
    }
    for (const database of ownedDatabases) {
      const found = await client.query<{ owner: string }>("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [
        database,
      ])
      const owner = found.rows[0]?.owner
      if (owner !== undefined && owner !== OWNER && (await roleExists(client, OWNER))) {
        await client.query(`ALTER DATABASE ${quoteIdent(database)} OWNER TO ${quoteIdent(OWNER)}`)
        console.log(`  adopted database ${database} (was ${owner}'s)`)
      }
    }
  })
}

async function ensureRole(client: Client, name: string, password: string): Promise<void> {
  if (!(await roleExists(client, name))) {
    // Plain: no CREATEDB, CREATEROLE, BYPASSRLS. The creator gets the ADMIN option.
    await client.query(`CREATE ROLE ${quoteIdent(name)} LOGIN`)
    console.log(`  created role ${name}`)
  }
  // Stated every run, so a drifted password is corrected rather than trusted.
  await client.query(`ALTER ROLE ${quoteIdent(name)} LOGIN PASSWORD ${literal(password)}`)
  const found = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [name],
  )
  const role = found.rows[0]
  if (role?.rolsuper === true || role?.rolbypassrls === true) {
    // The admin cannot remove an attribute it does not hold; step 1 can.
    throw new Error(`${name} can bypass row-level security. Run once with DATABASE_SUPERUSER_URL set to adopt it (ADR-0059).`)
  }
  console.log(`  role ${name}: no superuser, no bypassrls`)
}

async function ensureDatabase(client: Client, name: string): Promise<void> {
  const found = await client.query<{ owner: string }>("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [name])
  const owner = found.rows[0]?.owner
  if (owner === undefined) {
    await client.query(`CREATE DATABASE ${quoteIdent(name)} OWNER ${quoteIdent(OWNER)}`)
    console.log(`  created database ${name}`)
  } else if (owner !== OWNER) {
    throw new Error(`database ${name} belongs to ${owner}, not ${OWNER}. Run once with DATABASE_SUPERUSER_URL set to adopt it.`)
  } else {
    console.log(`  database ${name} already present`)
  }
}

/** Step 2: everything a managed database's master user may do. */
async function provisionDatabases(): Promise<void> {
  await withClient(adminUrl, async (client) => {
    const [me] = (await client.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows
    if (me?.rolsuper === true) {
      // A superuser would mask exactly the privileges this exists to prove absent.
      throw new Error("DATABASE_ADMIN_URL connects as a superuser. Use a CREATEROLE/CREATEDB role, as RDS's master user is.")
    }
    await ensureRole(client, OWNER, ownerPassword)
    await ensureRole(client, APP, appPassword)
    // CREATE DATABASE … OWNER needs the right to become the owner; INHERIT stays
    // off, so the admin holds none of the owner's privileges by default.
    await client.query(`GRANT ${quoteIdent(OWNER)} TO current_user WITH INHERIT FALSE, SET TRUE`)
    for (const database of ownedDatabases) await ensureDatabase(client, database)
  })

  // Privileges and default privileges are per-database. The owner grants them
  // itself: it owns the schema, so nothing here needs anyone above it. The
  // shadow database is Prisma's to wipe, and is not bootstrapped.
  const bootstrapSql = await readFile(path.join(import.meta.dirname, "../sql/bootstrap.sql"), "utf8")
  for (const database of databases) {
    await withClient(sibling(adminUrl, { user: OWNER, password: ownerPassword, database }), async (client) => {
      await client.query(bootstrapSql)
    })
    console.log(`  bootstrapped ${database}`)
  }
}

async function main(): Promise<void> {
  if (superuserUrl !== undefined) {
    console.log("instance (as a superuser)")
    await provisionInstance(superuserUrl)
  }
  console.log(`databases (as ${ADMIN})`)
  await provisionDatabases()
  console.log("bootstrap complete")
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
