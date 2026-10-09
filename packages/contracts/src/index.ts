/**
 * `@patchgrid/contracts` — the single source of truth for wire shapes.
 *
 * Depends on **zod only** (`ARCHITECTURE.md` §Dependency rules). It declares its
 * own enums rather than importing Prisma's, so the wire contract is independent of
 * the storage schema; a type-level test asserts the two stay mutually assignable.
 *
 * Domain schemas (tickets, memberships, transitions) arrive with the milestones
 * that introduce them. M0 establishes the primitives every surface shares.
 */

export * from "./audit.ts"
export * from "./auth.ts"
export * from "./cookies.ts"
export * from "./id.ts"
export * from "./limits.ts"
export * from "./me.ts"
export * from "./memberships.ts"
export * from "./organizations.ts"
export * from "./pagination.ts"
export * from "./permissions.ts"
export * from "./problems.ts"
export * from "./quotas.ts"
export * from "./reserved-slugs.ts"
export * from "./slug.ts"
export * from "./teams.ts"
export * from "./tenancy.ts"
export * from "./ticket-number.ts"
export * from "./tickets.ts"
