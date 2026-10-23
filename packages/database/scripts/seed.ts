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
import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"

import { createPrismaClient, lookalikeEmails, removeLookalikes, seedLookalikes } from "../src/index.ts"
import { seedDemoArticles } from "./demo-articles.ts"
import { seedDemoAssets } from "./demo-assets.ts"
import { seedDemoInbound } from "./demo-inbound.ts"
import { DEMO_SSO, seedDemoSso } from "./demo-sso.ts"
import { seedDemoProblemsAndChanges, seedDemoTickets } from "./demo-tickets.ts"

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
      // A demo person who has since joined another workspace cannot be deleted, and
      // finding that out halfway leaves acme and globex gone. Ask before removing anything.
      const elsewhere = await db.userOrgIndex.findMany({
        where: { userId: { in: users.map((u) => u.id) }, orgId: { notIn: existing.map((o) => o.id) } },
        select: { orgSlug: true, user: { select: { email: true } } },
      })
      if (elsewhere.length > 0) {
        for (const row of elsewhere) console.error(`  ${row.user.email} is also in ${row.orgSlug}`)
        throw new Error("seed: demo people belong to other workspaces — run `pnpm db:reset` to start from an empty database")
      }
      await removeLookalikes(db, { orgIds: existing.map((o) => o.id), userIds: users.map((u) => u.id) })
    }

    // Argon2id (an ambient const enum, so its value: 2); the API verifies whatever parameters a hash carries.
    const argon2id: Algorithm = 2
    const passwordHash = await hash(DEMO_PASSWORD, { algorithm: argon2id })
    const seeded = await seedLookalikes(db, { slugs: SLUGS, emailSuffix: "", passwordHash, slaTargets: DEFAULT_SLA_TARGETS })
    const pick = (members: Record<string, string>, keys: string[]) => keys.flatMap((k) => members[k] ?? [])
    const queues = [
      await seedDemoTickets(db, seeded.acme, { requesters: pick(seeded.acme.members, ["rita"]), agents: pick(seeded.acme.members, ["sam", "dana", "alice"]) }, 1),
      await seedDemoTickets(db, seeded.globex, { requesters: pick(seeded.globex.members, ["rosa"]), agents: pick(seeded.globex.members, ["tina", "dana", "gus"]) }, 2),
    ]
    const incidents = queues.reduce((n, q) => n + q.incidents, 0)
    const requests = queues.reduce((n, q) => n + q.requests, 0)

    const records = [
      await seedDemoProblemsAndChanges(db, seeded.acme, { lead: seeded.acme.members.sam ?? "", agents: pick(seeded.acme.members, ["sam", "dana"]), admin: seeded.acme.members.alice ?? "", watchers: pick(seeded.acme.members, ["dana", "rita"]) }, 1),
      await seedDemoProblemsAndChanges(db, seeded.globex, { lead: seeded.globex.members.tina ?? "", agents: pick(seeded.globex.members, ["tina", "dana"]), admin: seeded.globex.members.gus ?? "", watchers: pick(seeded.globex.members, ["dana", "rosa"]) }, 2),
    ]
    const assets =
      (await seedDemoAssets(db, seeded.acme, { requester: seeded.acme.members.rita ?? "", agent: seeded.acme.members.sam ?? "", admin: seeded.acme.members.alice ?? "" }, "ACME")) +
      (await seedDemoAssets(db, seeded.globex, { requester: seeded.globex.members.rosa ?? "", agent: seeded.globex.members.tina ?? "", admin: seeded.globex.members.gus ?? "" }, "GLBX"))
    const articles =
      (await seedDemoArticles(db, seeded.acme, { agent: seeded.acme.members.sam ?? "", admin: seeded.acme.members.alice ?? "" })) +
      (await seedDemoArticles(db, seeded.globex, { agent: seeded.globex.members.tina ?? "", admin: seeded.globex.members.gus ?? "" }))
    await seedDemoInbound(db, seeded.acme, { membershipId: seeded.acme.members.rita ?? "", email: seeded.people.rita.email })
    await seedDemoInbound(db, seeded.globex, { membershipId: seeded.globex.members.rosa ?? "", email: seeded.people.rosa.email })
    // Dana is also an operator: the back-office at admin.lvh.me, with a factor to enrol on first sign-in (ADR-0040).
    await db.platformAdmin.create({ data: { userId: seeded.people.dana.userId } })
    const sso = await seedDemoSso(db, { acme: seeded.acme.id, globex: seeded.globex.id })
    const problems = records.reduce((n, r) => n + r.problems, 0)
    const changes = records.reduce((n, r) => n + r.changes, 0)
    console.log(
      `seed: acme and globex are ready, with ${incidents} demo incidents, ${requests} service requests, ${problems} problems, ${changes} changes, ${assets} assets and ${articles} articles — every account's password is`,
      JSON.stringify(DEMO_PASSWORD),
    )
    for (const [key, person] of Object.entries(seeded.people)) console.log(`  ${key.padEnd(6)} ${person.email}`)
    console.log("  dana is an admin at http://acme.lvh.me:3001 and an agent at http://globex.lvh.me:3001")
    console.log("  dana is also an operator at http://admin.lvh.me:3001 — the first sign-in enrols an authenticator")
    console.log("  sam leads Network at Acme: changes awaiting approval are in his queues")
    if (sso) {
      console.log(`  acme signs in through Keycloak (${DEMO_SSO.issuer}): docker compose --profile sso up -d, then "Sign in with SSO" as kim@${DEMO_SSO.domain}`)
    } else {
      console.log("  set SSO_SECRETS_KEY to seed Acme's SSO connection")
    }
    console.log("  mail a ticket in: pnpm --filter @patchgrid/api run inbound:send -- --from rita@patchgrid.test --to acme")
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
