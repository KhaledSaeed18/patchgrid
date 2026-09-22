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

const PRISMA_MESSAGE =
  "Repositories are the only Prisma importers. A service that imports Prisma has started " +
  "doing data access, and the layering that keeps business rules testable without a " +
  "database is gone (ARCHITECTURE.md §Layered architecture)."

/**
 * Controller → Service → Repository.
 *
 * `src/prisma/**` is exempt because it *is* the data-access plumbing; everything
 * else in the API reaches the database through a repository.
 */
export const apiLayering = {
  ignores: ["src/prisma/**", "src/**/repositories/**", "**/*.spec.ts", "test/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "@prisma/client", message: PRISMA_MESSAGE },
          { name: "@patchgrid/database", message: PRISMA_MESSAGE },
        ],
        patterns: [
          { group: ["**/generated/client*"], message: PRISMA_MESSAGE },
        ],
      },
    ],
  },
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
  ignores: ["src/prisma/**", "src/**/repositories/**", "**/*.spec.ts", "test/**"],
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

/**
 * Crossing a tenant boundary is a decision, not a convenience.
 *
 * `runAsTenant` points the ordinary mechanism at a known org and is not a bypass;
 * `runAsPlatform` runs with no tenant context at all. Both are restricted by
 * *module* rather than by a count of call sites, so a legitimate new caller does
 * not require editing the rule — and an illegitimate one still cannot compile
 * (ADR-0022).
 */
export const tenantCrossing = {
  ignores: [
    "src/platform/**",
    "src/auth/**",
    "src/jobs/**",
    "src/orgs/provisioning/**",
    "**/*.spec.ts",
    "test/**",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/platform/run-as-*", "**/common/tenancy/run-as-*"],
            message:
              "runAsTenant / runAsPlatform may only be imported by src/platform, src/auth, " +
              "src/jobs and src/orgs/provisioning (ADR-0022). Everywhere else, the tenant comes " +
              "from the request context.",
          },
        ],
      },
    ],
  },
}
