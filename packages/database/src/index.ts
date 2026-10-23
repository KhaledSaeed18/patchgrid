import { Pool } from "pg"

import { PrismaClient } from "../generated/client/client.ts"
import { SerialPrismaPg } from "./serial-adapter.ts"

export { PrismaClient }
export type { Prisma } from "../generated/client/client.ts"
// Storage enums. apps/api asserts each is identical to its wire twin in
// @patchgrid/contracts (enum-parity.spec.ts); only repositories should need them.
export * from "../generated/client/enums.ts"
export {
  NoTenantContextError,
  tenantTransaction,
  withTenantIsolation,
  type TenantContext,
  type TenantContextReader,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from "./tenant-client.ts"
export { PLATFORM_TABLES, isTenantOwned } from "./table-classes.ts"
export { listen, type Listener, type ListenOptions, OUTBOX_CHANNEL } from "./listen.ts"
export {
  type Lookalikes,
  type LookalikeOptions,
  lookalikeEmails,
  removeLookalikes,
  seedLookalikes,
  type SeededOrg,
  type SeededPerson,
} from "./lookalikes.ts"

export type PrismaClientOptions = {
  /** A libpq connection string. The application always passes DATABASE_URL. */
  connectionString: string
  /** Pool ceiling. Every query runs in its own transaction (ADR-0015), so a
   *  connection is held for a full round trip — this is the number that decides
   *  how many concurrent requests the process can actually serve. */
  maxConnections?: number
  /** Handed the driver pool once it exists — for the saturation gauge, nothing else (ADR-0030). */
  onPool?: (pool: Pool) => void
}

/**
 * Prisma 7 takes a driver adapter rather than a connection string in the
 * datasource block. Two adapters give the two database roles two independent
 * pools, which is what the owner/app split wants.
 */
export function createPrismaClient({ connectionString, maxConnections, onPool }: PrismaClientOptions): PrismaClient {
  const pool = new Pool({
    connectionString,
    ...(maxConnections === undefined ? {} : { max: maxConnections }),
  })
  onPool?.(pool)
  return new PrismaClient({ adapter: new SerialPrismaPg(pool) })
}

/**
 * Boot assertion (ADR-0022, ADR-0059). Three ways a role escapes every tenant
 * policy in the database: being a superuser, holding BYPASSRLS, or having the
 * privileges of the role that owns the tables. Tables are not forced, so their
 * owner is exempt, and so is anyone who can act as it (ADR-0059). Any of the
 * three would turn the whole isolation story off, silently, and only in
 * whichever environment was misconfigured. Refusing to start turns that into a
 * failed deploy.
 *
 * The owner is read from the catalog, not assumed by name: it is whoever owns
 * `Organization`, which the first migration creates. `pg_class` is readable by
 * every role, so the answer never depends on the role being checked.
 *
 * Throws rather than returning a boolean: there is no caller for whom "the app
 * can read every tenant's data" is recoverable.
 */
export async function assertAppRoleCannotBypassRls(client: Pick<PrismaClient, "$queryRawUnsafe">): Promise<void> {
  const rows = await client.$queryRawUnsafe<
    { rolname: string; rolbypassrls: boolean; rolsuper: boolean; owner: string | null; actsAsOwner: boolean | null }[]
  >(
    `SELECT r.rolname, r.rolbypassrls, r.rolsuper,
            pg_get_userbyid(t.relowner) AS owner,
            pg_has_role(current_user, t.relowner, 'MEMBER') AS "actsAsOwner"
       FROM pg_roles r
       LEFT JOIN (pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public')
              ON t.relname = 'Organization' AND t.relkind = 'r'
      WHERE r.rolname = current_user`,
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
  if (role.owner === null || role.actsAsOwner === null) {
    throw new Error("The schema is not migrated: no table owner to check the application role against. Refusing to start.")
  }
  if (role.actsAsOwner) {
    throw new Error(
      `Database role "${role.rolname}" is, or is a member of, "${role.owner}", which owns the tenant tables ` +
        `and is therefore exempt from their policies (ADR-0059). Refusing to start.`,
    )
  }
}
