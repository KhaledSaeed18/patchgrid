/**
 * The platform class — the ONE closed list of tables that carry no tenant policy
 * (TENANCY.md §7). Everything else in the schema is tenant-owned: it has `orgId`,
 * an RLS policy, `orgId`-first indexes, and composite foreign keys to its
 * tenant-owned neighbours. `pnpm test:schema` enforces exactly that split, so a
 * new table is tenant-owned unless someone adds it here — deliberately, and in
 * review.
 *
 * Adding a table here is a security decision, not a bookkeeping one: it removes
 * the database's last line of defence for that table.
 */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set([
  "Organization",
  "OrganizationSlugHistory",
  "User",
  "PlatformAdmin",
  "RefreshToken",
  "PasswordResetToken",
  "EmailVerification",
  // Derived projections that answer "which tenant?" before one is known (ADR-0022)
  "UserOrgIndex",
  "ApiTokenIndex",
])

/** Tables that belong to tooling rather than to the product. */
export const TOOLING_TABLES: ReadonlySet<string> = new Set(["_prisma_migrations"])

export function isTenantOwned(table: string): boolean {
  return !PLATFORM_TABLES.has(table) && !TOOLING_TABLES.has(table)
}
