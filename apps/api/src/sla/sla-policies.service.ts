import { Injectable } from "@nestjs/common"
import type { Priority, SlaPolicy, TicketType, UpdateSlaPolicyRequest } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { NotFoundProblem } from "../common/problems/problem.exception"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { type SlaPolicyRecord, SlaPolicyRepository } from "./repositories/sla-policy.repository"

/**
 * SLA policies (DOMAIN.md §4.1). Agents read them; admins change them, which
 * never retargets an open ticket — deadlines are stored, so history stays
 * interpretable — and is audited as `SLA_POLICY_CHANGED`.
 */
@Injectable()
export class SlaPoliciesService {
  constructor(
    private readonly policies: SlaPolicyRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SlaPolicy[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "sla:read")
    return this.policies.list(this.tenant.requireOrgId())
  }

  /** The policy a ticket of this type and priority runs on; Problems and Changes have none. */
  policyFor(orgId: string, type: TicketType, priority: Priority): Promise<SlaPolicyRecord | null> {
    if (type !== "INCIDENT" && type !== "SERVICE_REQUEST") return Promise.resolve(null)
    return this.policies.find(orgId, type, priority)
  }

  async update(id: string, request: UpdateSlaPolicyRequest): Promise<SlaPolicy> {
    this.permissions.assert(this.actors.requireTenantActor(), "sla:write")
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      const before = await this.policies.findById(orgId, id)
      if (before === null) throw new NotFoundProblem()
      await this.policies.update(orgId, id, request)
      const diff = Object.fromEntries(
        (Object.keys(request) as (keyof UpdateSlaPolicyRequest)[])
          .filter((field) => request[field] !== before[field])
          .map((field) => [field, { from: before[field], to: request[field] }]),
      )
      if (Object.keys(diff).length > 0) {
        await this.audit.record(orgId, [
          {
            action: "SLA_POLICY_CHANGED",
            entityType: "SLAPolicy",
            entityId: id,
            diff: { ticketType: before.ticketType, priority: before.priority, ...diff },
          },
        ])
      }
      return { ...before, ...request }
    })
  }
}
