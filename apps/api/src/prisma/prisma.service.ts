import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common"
import {
  assertAppRoleCannotBypassRls,
  createPrismaClient,
  type PrismaClient,
  type TenantPrismaClient,
  type TenantTransactionClient,
  tenantTransaction,
  withTenantIsolation,
} from "@patchgrid/database"
import { ClsService } from "nestjs-cls"

import { InjectConfig, type AppConfig } from "../config/app-config"
import type { RequestContextStore } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"

/**
 * The open interactive transaction, when a repository call runs inside one.
 * Owned by this module: the tenancy store is extended here rather than made to
 * import Prisma types (ARCHITECTURE.md §Dependency rules).
 */
declare module "../tenancy/request-context" {
  interface RequestContextStore {
    prismaTransaction?: OpenTransaction
  }
}

type OpenTransaction = {
  /** The tenant the transaction's first statement set — `null` for a platform-only one. */
  orgId: string | null
  client: TenantTransactionClient
}

/**
 * Owns the database connection and isolation layer 3 (ADR-0015, ADR-0022).
 *
 * Repositories are the only consumers — services never see this, and never
 * see Prisma at all (`ARCHITECTURE.md` §Layered architecture). They read `db`,
 * which is the tenant-isolated client, or the open transaction when one is
 * active for the current tenant, so a repository method is written once and
 * behaves the same inside and outside `transaction()`.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)
  private readonly base: PrismaClient
  private readonly tenantClient: TenantPrismaClient

  constructor(
    @InjectConfig() private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly tenantContext: TenantContextService,
  ) {
    this.base = createPrismaClient({
      connectionString: config.DATABASE_URL,
      maxConnections: config.DATABASE_POOL_MAX,
    })
    // Every tenant-owned query reads the tenant from the request context at
    // the moment it is awaited, and throws if there is none.
    this.tenantClient = withTenantIsolation(this.base, () => this.tenantContext.current())
  }

  /**
   * The client a repository uses. Inside `transaction()` it is the transaction
   * — but only when that transaction was opened for the CURRENT tenant. A
   * transaction left over from another scope (a `runAsTenant` inside one) is
   * never reused, whatever the store says.
   */
  get db(): TenantTransactionClient {
    const open = this.cls.isActive() ? this.cls.get("prismaTransaction") : undefined
    if (open === undefined) return this.tenantClient
    const current = this.tenantContext.current()?.orgId ?? null
    return open.orgId === current ? open.client : this.tenantClient
  }

  /**
   * Runs `fn` in one interactive transaction scoped to the current tenant
   * (ENGINEERING.md §Transactions and side effects): the mutation, its audit
   * rows and any counter increment commit or roll back together.
   *
   * - The first statement sets `app.current_org_id` transaction-locally, so
   *   RLS applies to everything in `fn`.
   * - With no tenant context the transaction is platform-only: a tenant-owned
   *   query inside it still throws.
   * - A nested call joins the open transaction rather than starting another;
   *   Prisma has no savepoints, so "nested" means "same transaction".
   * - `fn` receives the transaction client, and `db` returns the same client
   *   for the duration, so repositories need not be told about it.
   */
  async transaction<T>(fn: (tx: TenantTransactionClient) => Promise<T>): Promise<T> {
    const current = this.tenantContext.current()
    const orgId = current?.orgId ?? null

    const open = this.cls.isActive() ? this.cls.get("prismaTransaction") : undefined
    if (open !== undefined && open.orgId === orgId) return fn(open.client)

    // A child context: the transaction slot and the `inTransaction` flag must
    // not outlive `fn`, and must not be visible to concurrent work sharing the
    // parent store. Await INSIDE it — Prisma promises are lazy.
    return this.cls.run({ ifNested: "inherit" }, async () => {
      if (orgId === null) {
        return await this.tenantClient.$transaction(async (tx) => {
          this.cls.set("prismaTransaction", { orgId: null, client: tx })
          return await fn(tx)
        })
      }

      this.cls.set("tenant", { orgId, inTransaction: true })
      return await tenantTransaction(this.tenantClient, orgId, async (tx) => {
        this.cls.set("prismaTransaction", { orgId, client: tx })
        return await fn(tx)
      })
    })
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect()

    // Refuse to start as a role that can ignore row-level security. A
    // misconfiguration here is not degraded service — it is every tenant able to
    // read every other tenant, silently, in whichever environment got it wrong
    // (ADR-0022).
    await assertAppRoleCannotBypassRls(this.base)

    this.logger.log(
      `connected to postgres (pool max ${String(this.config.DATABASE_POOL_MAX)}, RLS enforced)`,
    )
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect()
  }

  /** Cheap liveness probe for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.base.$queryRawUnsafe("SELECT 1")
  }
}
