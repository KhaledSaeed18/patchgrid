/**
 * Development and demo seed (TENANCY.md §10).
 *
 * Two organizations, `acme` and `globex`, with deliberately similar data, and
 * Dana — an admin at Acme and an agent at Globex — to hold both open in two
 * tabs. Written as the owner role. Idempotent: an existing seed is left alone
 * unless `--reset` asks for it to be replaced.
 *
 *   pnpm db:seed            # once
 *   pnpm db:seed -- --reset # throw the demo workspaces away and start again
 */
import path from "node:path"
import process from "node:process"

import { type Algorithm, hash } from "@node-rs/argon2"

import { createPrismaClient, lookalikeEmails, removeLookalikes, seedLookalikes } from "../src/index.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

/** Twelve characters or more, as the policy wants (ADR-0032). Demo only; never deployed. */
const DEMO_PASSWORD = "patchgrid-demo"
const SLUGS = { acme: "acme", globex: "globex" }

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL
  if (url === undefined || url === "") throw new Error("DATABASE_MIGRATION_URL is required")
  const db = createPrismaClient({ connectionString: url })
  try {
    const existing = await db.organization.findMany({ where: { slug: { in: Object.values(SLUGS) } }, select: { id: true } })
    if (existing.length > 0) {
      if (!process.argv.includes("--reset")) {
        console.log("seed: acme and globex already exist — run with --reset to replace them")
        return
      }
      const users = await db.user.findMany({ where: { email: { in: lookalikeEmails("") } }, select: { id: true } })
      await removeLookalikes(db, { orgIds: existing.map((o) => o.id), userIds: users.map((u) => u.id) })
    }

    // Argon2id (an ambient const enum, so its value: 2); the API verifies whatever parameters a hash carries.
    const argon2id: Algorithm = 2
    const passwordHash = await hash(DEMO_PASSWORD, { algorithm: argon2id })
    const seeded = await seedLookalikes(db, { slugs: SLUGS, emailSuffix: "", passwordHash })

    console.log("seed: acme and globex are ready — every account's password is", JSON.stringify(DEMO_PASSWORD))
    for (const [key, person] of Object.entries(seeded.people)) console.log(`  ${key.padEnd(6)} ${person.email}`)
    console.log("  dana is an admin at http://acme.lvh.me:3001 and an agent at http://globex.lvh.me:3001")
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
