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

export * from "./id.ts"
export * from "./limits.ts"
export * from "./pagination.ts"
export * from "./problems.ts"
export * from "./reserved-slugs.ts"
export * from "./slug.ts"
export * from "./tenancy.ts"
export * from "./ticket-number.ts"
