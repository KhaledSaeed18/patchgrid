import { Controller, Get, Param } from "@nestjs/common"
import type { TenantLookup } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { Public } from "../common/decorators/route-markers"
import { TenantLookupService } from "./tenant-lookup.service"

/**
 * Any string: whether it is a slug is the service's question, and the answer to
 * "not a slug" is the same 404 as "no such slug" — a 400 would tell a prober
 * which labels to skip. The bound only keeps a pathological URL off the lookup.
 */
class TenantSlugParams extends createZodDto(z.object({ slug: z.string().max(128) })) {}

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
  lookup(@Param() params: TenantSlugParams): Promise<TenantLookup> {
    return this.tenants.lookup(params.slug)
  }
}
