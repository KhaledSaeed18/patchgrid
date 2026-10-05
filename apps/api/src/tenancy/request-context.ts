import type { ClsStore } from "nestjs-cls"

/**
 * Isolation layer 1 (TENANCY.md §7): what the request context holds.
 *
 * The store is `AsyncLocalStorage` via `nestjs-cls`, opened by the CLS
 * middleware for every request and by `runAsTenant` / `runAsPlatform` for
 * everything that is not a request. Only three places ever WRITE to it — the
 * tenant resolution middleware, those two helpers, and `PrismaService` for the
 * transaction slot — and the linter confines `nestjs-cls` to exactly those
 * modules. Everyone else reads through `TenantContextService`.
 *
 * Other modules extend this interface by declaration merging rather than by
 * importing their types here, so the tenancy module stays free of Prisma.
 */
export interface RequestContextStore extends ClsStore {
  /**
   * The organization every tenant-owned query is scoped to. Absent means
   * "no tenant": a tenant-owned query throws, a platform-class query runs.
   */
  tenant?: TenantScope
}

export type TenantScope = {
  orgId: string
  /**
   * True while an interactive transaction is open for this tenant. The
   * transaction's first statement already set the tenant, so the client
   * extension passes through instead of opening a nested one
   * (ENGINEERING.md §Transactions and side effects).
   */
  inTransaction: boolean
}

/**
 * Thrown by `requireOrgId()` when code that only makes sense inside a tenant
 * runs outside one. A programming error, not a request error: it surfaces as
 * a 500 with a correlation id, never as a leak.
 */
export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING"

  constructor(what: string) {
    super(
      `${what} requires a tenant context, and there is none. It must run inside a ` +
        "tenant-resolved request or inside runAsTenant — and be awaited INSIDE it.",
    )
    this.name = "TenantContextMissingError"
  }
}
