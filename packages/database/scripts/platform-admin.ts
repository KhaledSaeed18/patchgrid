/**
 * Granting and revoking operators (RBAC.md §8, ADR-0040) — the only way
 * either happens. There is no API route that makes a platform admin, so there
 * is no route to abuse.
 *
 *   pnpm platform:grant dana@patchgrid.test
 *   pnpm platform:revoke dana@patchgrid.test
 *
 * The account must exist and be verified. Both are written to the platform's
 * own log, by no admin: the CLI is the operator of last resort. A revocation
 * takes effect on the operator's next request — the API reads the grant on
 * every one.
 */
import path from "node:path"

import { createPrismaClient } from "../src/index.ts"

try {
  process.loadEnvFile(path.join(import.meta.dirname, "../../../.env"))
} catch {
  // variables come from the environment
}

async function main(): Promise<void> {
  const [command, rawEmail] = process.argv.slice(2).filter((arg) => arg !== "--")
  const email = rawEmail?.trim().toLowerCase()
  if ((command !== "grant" && command !== "revoke") || email === undefined || email === "") {
    console.error("usage: platform-admin.ts grant|revoke <email>")
    process.exit(2)
  }
  const url = process.env.DATABASE_MIGRATION_URL
  if (url === undefined || url === "") throw new Error("DATABASE_MIGRATION_URL is required")
  const db = createPrismaClient({ connectionString: url })
  try {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true, anonymisedAt: true } })
    if (user === null || user.emailVerifiedAt === null || user.anonymisedAt !== null) {
      console.error(`platform: no verified account for ${email}`)
      process.exit(1)
    }
    if (command === "grant") {
      const admin = await db.platformAdmin.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: { revokedAt: null },
        select: { id: true },
      })
      await db.platformAuditLog.create({ data: { action: "PLATFORM_ADMIN_GRANTED", targetUserId: user.id, diff: { platformAdminId: admin.id } } })
      const factor = await db.userMfaFactor.findFirst({ where: { userId: user.id, confirmedAt: { not: null } }, select: { id: true } })
      console.log(`platform: ${email} is an operator.`)
      if (factor === null) {
        console.log("  No second factor yet: the first sign-in at admin.<domain> enrols one, before any session (ADR-0040).")
      }
      return
    }
    const { count } = await db.platformAdmin.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })
    if (count === 0) {
      console.log(`platform: ${email} was not an operator.`)
      return
    }
    await db.platformAuditLog.create({ data: { action: "PLATFORM_ADMIN_REVOKED", targetUserId: user.id } })
    console.log(`platform: ${email} is no longer an operator; any session ends on its next request.`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
