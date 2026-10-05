import { Inject, Injectable } from "@nestjs/common"
import { slugSchema, type TenantLookup } from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../common/clock/clock"
import { NotFoundProblem } from "../common/problems/problem.exception"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "./organization-lookup"

/**
 * What a subdomain should do before any session exists (TENANCY.md §2):
 * exact slug → slug history within its window → 404.
 *
 * Public by design: slug existence is accepted risk R-2. What it never says is
 * anything about accounts or members — only whether `<slug>.patchgrid.xyz`
 * renders, redirects, or does not exist. A workspace pending deletion does not
 * exist, from the outside (TENANCY.md §3).
 */
@Injectable()
export class TenantLookupService {
  constructor(
    @Inject(ORGANIZATION_LOOKUP) private readonly organizations: OrganizationLookup,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async lookup(candidate: string): Promise<TenantLookup> {
    // A malformed or reserved label cannot be a tenant, and saying "invalid"
    // rather than "not found" would only tell a prober which labels to skip.
    const slug = slugSchema.safeParse(candidate)
    if (!slug.success) throw new NotFoundProblem("Unknown workspace")

    const current = await this.organizations.bySlug(slug.data)
    if (current !== null) {
      switch (current.status) {
        case "ACTIVE":
          return { status: "active", slug: slug.data }
        case "SUSPENDED":
          return { status: "suspended", slug: slug.data }
        case "PENDING_DELETION":
          throw new NotFoundProblem("Unknown workspace")
      }
    }

    const retired = await this.organizations.retiredSlug(slug.data, this.clock.now())
    const moved = retired === null ? null : await this.organizations.byId(retired.orgId)
    if (moved === null || moved.status === "PENDING_DELETION") {
      throw new NotFoundProblem("Unknown workspace")
    }
    // 302 to the new name — a suspended destination shows its own 403 there.
    return { status: "moved", slug: slug.data, currentSlug: moved.slug }
  }
}
