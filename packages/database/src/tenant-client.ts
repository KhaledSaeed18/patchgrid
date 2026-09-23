import type { PrismaClient } from "../generated/client/client.ts"
import { isTenantOwned } from "./table-classes.ts"

/**
 * Isolation layer 3 (ADR-0015): a Prisma client extension that runs every query
 * on a tenant-owned model inside a transaction whose first statement is
 *
 *   SELECT set_config('app.current_org_id', <orgId>, true)
 *
 * so the RLS policies (layer 4) see the tenant. With no tenant context, a query
 * on a tenant-owned model THROWS rather than running unscoped.
 *
 * The context itself lives outside this package — `nestjs-cls` for requests,
 * `runAsTenant` for jobs — and is read through `TenantContextReader`, so this
 * package depends on no framework.
 */

export type TenantContext = {
  orgId: string
  /**
   * True while a `tenantTransaction` is open for this context. Its first
   * statement already set the tenant, and Prisma's transaction client has no
   * `$transaction`, so the extension must pass through rather than wrap
   * (ENGINEERING.md §Transactions and side effects).
   */
  inTransaction?: boolean
}

/** Returns the current tenant context, or `undefined` when there is none. */
export type TenantContextReader = () => TenantContext | undefined

export class NoTenantContextError extends Error {
  readonly code = "NO_TENANT_CONTEXT"

  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} ran with no tenant context. ${model} is tenant-owned, so it ` +
        "must run inside a request or runAsTenant. If this call is inside one, the promise " +
        "was probably awaited OUTSIDE the context: Prisma promises are lazy, so the context " +
        "must be `run(ctx, async () => await fn())`, not `run(ctx, () => fn())`.",
    )
    this.name = "NoTenantContextError"
  }
}

/**
 * `true` makes the setting TRANSACTION-local. It must never become session-level
 * (`false`): pooled connections are shared between requests, and a session-level
 * tenant would leak into whichever request draws the connection next (ADR-0015).
 */
function setTenant(client: Pick<PrismaClient, "$queryRaw">, orgId: string) {
  return client.$queryRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`
}

export function withTenantIsolation(client: PrismaClient, readContext: TenantContextReader) {
  return client.$extends({
    name: "tenant-isolation",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Platform-class tables have no policy and are reachable before a
          // tenant is known (ADR-0022). Model names are table names: the schema
          // uses no @@map.
          if (!isTenantOwned(model)) return query(args)

          const context = readContext()
          if (context === undefined) throw new NoTenantContextError(model, operation)
          if (context.inTransaction === true) return query(args)

          // A single operation cannot be redirected onto a transaction client,
          // so the setting and the query go in one batched transaction — the
          // shape the isolation spike verified (ADR-0015 erratum).
          const [, result] = await client.$transaction([setTenant(client, context.orgId), query(args)])
          return result
        },
      },
    },
  })
}

export type TenantPrismaClient = ReturnType<typeof withTenantIsolation>

/**
 * Opens an interactive transaction scoped to `orgId`. Its first statement sets
 * the tenant, so every query in `fn` is subject to RLS for that org.
 *
 * The caller must mark its context `inTransaction` while `fn` runs, and must
 * await inside that context, so the extension passes through instead of trying
 * to open a nested transaction.
 */
export async function tenantTransaction<T>(
  client: TenantPrismaClient,
  orgId: string,
  fn: (tx: Parameters<Parameters<TenantPrismaClient["$transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await setTenant(tx, orgId)
    return await fn(tx)
  })
}
