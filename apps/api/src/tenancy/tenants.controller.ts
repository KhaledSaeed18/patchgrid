import { Controller, Get, Param } from "@nestjs/common"
import type { TenantLookup } from "@patchgrid/contracts"

import { Public } from "../common/decorators/route-markers"
import { TenantLookupService } from "./tenant-lookup.service"

/**
 * `GET /tenants/:slug` — consumed by `apps/app`'s host parsing to decide
 * whether a subdomain renders, 302s to its new name, or 404s.
 *
 * `@Public` deliberately: this is the one place slug existence is answered
 * on purpose (threat model R-2). Throttled per IP with the other anonymous
 * endpoints (pipeline step 3).
 */
@Controller("tenants")
export class TenantsController {
  constructor(private readonly tenants: TenantLookupService) {}

  @Get(":slug")
  @Public()
  lookup(@Param("slug") slug: string): Promise<TenantLookup> {
    return this.tenants.lookup(slug)
  }
}
