import { Injectable } from "@nestjs/common"
import { ClsService } from "nestjs-cls"

import {
  type RequestContextStore,
  TenantContextMissingError,
  type TenantScope,
} from "./request-context"
import type { ResolvedTenant } from "./tenant-resolver"

/**
 * The read side of the request context.
 *
 * Deliberately has no setter. The tenant is established by the resolution
 * middleware from the credential (ADR-0024) or by `runAsTenant` for a known
 * org (ADR-0022); a service that could set it would be a service that could
 * point itself at another tenant.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  /** The current tenant, or `undefined` outside one. Safe to call anywhere. */
  current(): TenantScope | undefined {
    return this.cls.get("tenant")
  }

  /** The current tenant's organization id, or a thrown programming error. */
  requireOrgId(what = "This operation"): string {
    const tenant = this.current()
    if (tenant === undefined) throw new TenantContextMissingError(what)
    return tenant.orgId
  }

  /**
   * What resolution learned about the organization — slug, plan, agent
   * visibility. Present on resolved requests only; a crossing has a tenant but
   * no resolved organization.
   */
  organization(): ResolvedTenant | undefined {
    return this.cls.get("organization")
  }

  /** The request id the logger issued, when running inside a request. */
  requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined
  }
}
