import type { OrganizationSummary } from "../platform/repositories/organization.repository"

/**
 * The questions tenant resolution asks, as a port so the resolver and the
 * guard can be tested without Redis or Postgres (ADR-0011).
 */
export interface OrganizationLookup {
  byId(id: string): Promise<OrganizationSummary | null>
  bySlug(slug: string): Promise<OrganizationSummary | null>
  /** `null` when the prefix is unknown OR the token is revoked — both are "no tenant". */
  orgIdForTokenPrefix(prefix: string): Promise<string | null>
  /** A slug this org used to have, while its redirect window is open. */
  retiredSlug(slug: string, now: Date): Promise<{ orgId: string } | null>
}

export const ORGANIZATION_LOOKUP = Symbol("ORGANIZATION_LOOKUP")
