import { plugin } from "./rules/import-zones.js"

/**
 * Architectural boundaries, enforced by the linter.
 *
 * These are the rules in `CLAUDE.md` that a reviewer would otherwise have to
 * remember. Each one guards an invariant where the failure is silent: a frontend
 * that reaches the database directly still works, right up until it duplicates a
 * permission check; a service that imports Prisma still works, right up until the
 * business rule lives in two places.
 *
 * They are deliberately written before most of the code they guard exists —
 * a rule added after the violation is a refactor, not a rule.
 *
 * The API's boundaries are ZONES of one custom rule (`rules/import-zones.js`),
 * not several `no-restricted-imports` objects: flat config lets a later object
 * replace an earlier one's options for the same rule, which silently switched
 * off every boundary but the last. Each boundary was proven to fire by planting
 * the violation it names.
 */

/** Frontends never touch the database. All data goes through the API over HTTP (ADR-0007). */
export const noDatabaseInFrontend = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@patchgrid/database",
            message:
              "Frontends never import the database package — including server components and " +
              "server actions. SLA maths, RBAC, quotas, audit logging and tenant isolation live " +
              "in exactly one place, behind the API (ARCHITECTURE.md §Dependency rules).",
          },
          {
            name: "@prisma/client",
            message: "Frontends never import Prisma. Go through the API.",
          },
        ],
      },
    ],
  },
}

const TESTS = ["**/*.spec.ts", "test/**"]

/**
 * Controller → Service → Repository.
 *
 * `src/prisma/**` is exempt because it *is* the data-access plumbing; everything
 * else in the API reaches the database through a repository.
 */
const layering = {
  files: ["src/**/*.ts"],
  except: ["src/prisma/**", "src/**/repositories/**", ...TESTS],
  imports: [
    { name: "@prisma/client" },
    { name: "@patchgrid/database" },
    { regex: "/generated/client" },
  ],
  message:
    "Repositories are the only Prisma importers. A service that imports Prisma has started " +
    "doing data access, and the layering that keeps business rules testable without a " +
    "database is gone (ARCHITECTURE.md §Layered architecture).",
}

/**
 * Crossing a tenant boundary is a decision, not a convenience.
 *
 * `runAsTenant` points the ordinary mechanism at a known org and is not a bypass;
 * `runAsPlatform` runs with no tenant context at all. Each is restricted by
 * *module* rather than by a count of call sites, so a legitimate new caller does
 * not require editing the rule — and an illegitimate one still cannot lint
 * (ADR-0022). Two zones, because the allow-lists differ: a per-tenant job may
 * point at its own org but has no business running with no tenant at all.
 */
const platformCrossing = {
  files: ["src/**/*.ts"],
  except: ["src/platform/**", "src/auth/**", "src/jobs/dispatcher/**", ...TESTS],
  imports: [{ regex: "(^|/)platform/run-as-platform$" }],
  message:
    "runAsPlatform may only be imported by src/platform, src/auth and src/jobs/dispatcher " +
    "(ADR-0022). Everywhere else, the tenant comes from the request context — a per-tenant " +
    "job uses runAsTenant.",
}

const tenantCrossing = {
  files: ["src/**/*.ts"],
  except: [
    "src/platform/**",
    "src/auth/**",
    "src/jobs/**",
    "src/orgs/provisioning/**",
    ...TESTS,
  ],
  imports: [{ regex: "(^|/)platform/run-as-tenant$" }],
  message:
    "runAsTenant may only be imported by src/platform, src/auth, src/jobs and " +
    "src/orgs/provisioning (ADR-0022). Everywhere else, the tenant comes from the request " +
    "context.",
}

/**
 * The request context is written in exactly four places: the tenancy module
 * (resolution: the tenant), the Prisma service (the transaction slot), the two
 * crossing helpers (the tenant, for a crossing) and the auth module (the actor,
 * once the credential is verified). Everyone else reads it through
 * `TenantContextService` and `ActorService`, which have no setters — so the only
 * way to point a query at another tenant is through a helper the zones above
 * confine (TENANCY.md §7, layer 1).
 */
const contextWriters = {
  files: ["src/**/*.ts"],
  except: ["src/tenancy/**", "src/prisma/**", "src/platform/**", "src/auth/**", ...TESTS],
  imports: [{ name: "nestjs-cls" }],
  message:
    "Only src/tenancy, src/prisma, src/platform and src/auth may touch the CLS store. Read the " +
    "tenant through TenantContextService and the actor through ActorService; cross tenants " +
    "through runAsTenant / runAsPlatform (ADR-0022).",
}

/**
 * `PermissionService.can()` is pure — role, subject and relationship flags in,
 * boolean out (RBAC.md §11). The authz module therefore reaches no data at all:
 * no repository, no Prisma, no Redis. Whatever a decision needs, the calling
 * service loads into a `Subject` first; that purity is what lets the whole
 * matrix be tested as data.
 */
const authzPurity = {
  files: ["src/authz/**/*.ts"],
  except: [...TESTS],
  imports: [
    { regex: "(^|/)(repositories|prisma|redis)(/|$)" },
    { name: "ioredis" },
  ],
  message:
    "The authz module does no I/O (RBAC.md §11). Load what the decision needs into a Subject " +
    "in the calling service and pass it in.",
}

export const API_ZONES = [layering, platformCrossing, tenantCrossing, contextWriters, authzPurity]

/** Every import boundary of `apps/api`, in one rule so none can override another. */
export const apiBoundaries = {
  plugins: { patchgrid: plugin },
  rules: { "patchgrid/import-zones": ["error", { zones: API_ZONES }] },
}

/**
 * Raw SQL bypasses the tenant client extension.
 *
 * Verified, not theorised: a raw query reaches the extension with `model`
 * undefined, so the tenant guard cannot fire and layer 3 is genuinely skipped.
 * RLS still catches it, which makes the failure safe — but it leaves one layer
 * instead of two, and that is the whole reason for the restriction (ADR-0015).
 */
export const noRawSql = {
  ignores: ["src/prisma/**", "src/**/repositories/**", ...TESTS],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "MemberExpression[property.name=/^\\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/]",
        message:
          "Raw SQL bypasses the tenant client extension and is protected by RLS alone. It belongs " +
          "in packages/database or a repository, never in application code (ENGINEERING.md " +
          "§Transactions and side effects).",
      },
    ],
  },
}
