/**
 * The API's boot assertion (ADR-0022, ADR-0059) against a live database. Tables
 * are not forced, so anyone who can act as their owner is exempt from every
 * policy: an app role made a member of the owner must stop the API starting,
 * exactly as BYPASSRLS would. Roles are made and dropped by the admin, the
 * CREATEROLE-only role of `db:bootstrap`.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import process from "node:process"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { assertAppRoleCannotBypassRls, createPrismaClient } from "../src/index.ts"

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

const appUrl = requireEnv("DATABASE_URL")
const adminUrl = requireEnv("DATABASE_ADMIN_URL")
const role = `probe_${randomUUID().slice(0, 8)}`
const password = randomUUID()
let admin: Client

/** The app's own connection string, as the probe role. */
function asProbe(): string {
  const url = new URL(appUrl)
  url.username = role
  url.password = password
  return url.toString()
}

async function assertAs(url: string): Promise<void> {
  const client = createPrismaClient({ connectionString: url })
  try {
    await assertAppRoleCannotBypassRls(client)
  } finally {
    await client.$disconnect()
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
  await admin.query(`GRANT CONNECT ON DATABASE ${new URL(appUrl).pathname.slice(1)} TO ${role}`)
})

afterAll(async () => {
  await admin.query(`DROP ROLE IF EXISTS ${role}`)
  await admin.end()
})

describe("assertAppRoleCannotBypassRls", () => {
  it("lets the app role start: no superuser, no BYPASSRLS, no member of the owner", async () => {
    await expect(assertAs(appUrl)).resolves.toBeUndefined()
  })

  it("refuses a role that can act as the owner, by any path — even without inheriting its privileges", async () => {
    await expect(assertAs(asProbe())).resolves.toBeUndefined()
    await admin.query(`GRANT patchgrid_owner TO ${role} WITH INHERIT FALSE, SET TRUE`)
    try {
      await expect(assertAs(asProbe())).rejects.toThrow(/member of, "patchgrid_owner"/)
    } finally {
      await admin.query(`REVOKE patchgrid_owner FROM ${role}`)
    }
  })
})
