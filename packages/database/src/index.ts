import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "../generated/client/client.ts"

export { PrismaClient }
export type { Prisma } from "../generated/client/client.ts"
// Storage enums. apps/api asserts each is identical to its wire twin in
// @patchgrid/contracts (enum-parity.spec.ts); only repositories should need them.
export * from "../generated/client/enums.ts"

export type PrismaClientOptions = {
  /** A libpq connection string. The application always passes DATABASE_URL. */
  connectionString: string
  /** Pool ceiling. Every query runs in its own transaction (ADR-0015), so a
   *  connection is held for a full round trip — this is the number that decides
   *  how many concurrent requests the process can actually serve. */
  maxConnections?: number
}

/**
 * Prisma 7 takes a driver adapter rather than a connection string in the
 * datasource block. Two adapters give the two database roles two independent
 * pools, which is what the owner/app split wants.
 */
export function createPrismaClient({
  connectionString,
  maxConnections,
}: PrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    ...(maxConnections === undefined ? {} : { max: maxConnections }),
  })
  return new PrismaClient({ adapter })
}

/**
 * Boot assertion (ADR-0022). A role holding BYPASSRLS ignores every tenant
 * policy in the database, so the whole isolation story would be off — silently,
 * and only in whichever environment was misconfigured. Refusing to start turns
 * that into a failed deploy.
 *
 * Throws rather than returning a boolean: there is no caller for whom "the app
 * can read every tenant's data" is recoverable.
 */
export async function assertAppRoleCannotBypassRls(
  client: Pick<PrismaClient, "$queryRawUnsafe">,
): Promise<void> {
  const rows = await client.$queryRawUnsafe<
    { rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]
  >(
    `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
  )

  const role = rows[0]
  if (role === undefined) {
    throw new Error("Could not resolve the current database role")
  }
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Database role "${role.rolname}" can bypass row-level security ` +
        `(superuser=${role.rolsuper}, bypassrls=${role.rolbypassrls}). ` +
        `The application must connect as patchgrid_app. Refusing to start.`,
    )
  }
}
