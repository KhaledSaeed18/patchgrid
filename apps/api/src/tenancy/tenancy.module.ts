import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { ClsModule } from "nestjs-cls"

import { PlatformModule } from "../platform/platform.module"
import { ORGANIZATION_LOOKUP } from "./organization-lookup"
import { OrganizationLookupService } from "./organization-lookup.service"
import { TenantContextService } from "./tenant-context.service"
import { TenantLookupService } from "./tenant-lookup.service"
import { TenantResolutionGuard } from "./tenant-resolution.guard"
import { TenantResolver } from "./tenant-resolver"
import { TenantsController } from "./tenants.controller"

/**
 * Isolation layer 1 (TENANCY.md §7): the request context and what fills it.
 *
 * - The CLS middleware wraps every route (pipeline step 5), keyed by the id
 *   pino-http already issued, so there is a store before any guard runs.
 * - `TenantResolutionGuard` (step 4) is registered here as a global guard and
 *   is the only thing that writes a tenant into a request's store. A route
 *   that reaches a repository without it finds an empty store, and the client
 *   extension throws rather than running unscoped.
 * - `GET /tenants/:slug` is the public answer to "what should this subdomain
 *   do?" — the API side of slug-history redirects (ADR-0017).
 */
@Global()
@Module({
  imports: [
    PlatformModule,
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        // pino-http has already stamped `req.id`, so the CLS id and the log
        // lines agree. The fallback exists for a route the logger skips.
        idGenerator: (req: IncomingMessage & { id?: unknown }) =>
          typeof req.id === "string" && req.id !== "" ? req.id : randomUUID(),
      },
    }),
  ],
  controllers: [TenantsController],
  providers: [
    TenantContextService,
    TenantLookupService,
    OrganizationLookupService,
    { provide: ORGANIZATION_LOOKUP, useExisting: OrganizationLookupService },
    TenantResolver,
    { provide: APP_GUARD, useClass: TenantResolutionGuard },
  ],
  exports: [TenantContextService, OrganizationLookupService],
})
export class TenancyModule {}
