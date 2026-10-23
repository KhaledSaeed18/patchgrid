import { Injectable } from "@nestjs/common"
import type { ApiToken, CreateApiTokenRequest, CreatedApiToken } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { StepUpService } from "../auth/mfa/step-up.service"
import { PasswordService } from "../auth/passwords/password.service"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem } from "../common/problems/problem.exception"
import { ApiTokenIndexRepository } from "../platform/repositories/api-token-index.repository"
import { PrismaService } from "../prisma/prisma.service"
import { QuotaService } from "../quota/quota.service"
import { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { mintToken, toApiToken } from "./domain"
import { ApiTokenRepository } from "./repositories/api-token.repository"

const DAY_MS = 24 * 60 * 60_000

/**
 * A workspace's API tokens (ADR-0021, ADR-0042): admins and owners list,
 * create and revoke them. Creation makes the token's service account, its
 * index row and its audit row in one transaction, and is the only time the
 * secret is ever in a response.
 */
@Injectable()
export class ApiTokensService {
  constructor(
    private readonly tokens: ApiTokenRepository,
    private readonly index: ApiTokenIndexRepository,
    private readonly lookup: OrganizationLookupService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(): Promise<ApiToken[]> {
    this.permissions.assert(this.actors.requireTenantActor(), "token:read")
    const now = this.clock.now()
    return (await this.tokens.list(this.tenant.requireOrgId())).map((row) => toApiToken(row, now))
  }

  async create(request: CreateApiTokenRequest): Promise<CreatedApiToken> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "token:create")
    // A token outlives the session that made it: a fresh proof first (ADR-0029).
    this.stepUp.assert(actor)
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const minted = mintToken()
    const tokenHash = await this.passwords.hash(minted.secret)
    const expiresAt = request.expiresInDays === null ? null : new Date(now.getTime() + request.expiresInDays * DAY_MS)
    const id = await this.prisma.transaction(async () => {
      const created = await this.tokens.create(
        orgId,
        {
          name: request.name,
          role: request.role,
          prefix: minted.prefix,
          tokenHash,
          scopes: request.scopes,
          createdByMembershipId: actor.membershipId,
          expiresAt,
        },
        now,
      )
      await this.index.create(minted.prefix, orgId)
      // A token's service account holds no seat; the plan bounds the tokens instead (TENANCY.md §8).
      await this.quota.consume(orgId, "API_TOKENS")
      await this.audit.record(orgId, [
        {
          action: "TOKEN_CREATED",
          entityType: "ApiToken",
          entityId: created,
          diff: {
            name: request.name,
            prefix: minted.prefix,
            role: request.role,
            scopes: request.scopes,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
      ])
      return created
    })
    return { token: await this.one(orgId, id), secret: minted.token }
  }

  /** At once: the token's next request is refused, and its service account is disabled. */
  async revoke(id: string): Promise<ApiToken> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "token:revoke")
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const prefix = await this.prisma.transaction(async () => {
      const found = await this.tokens.find(orgId, id)
      if (found === null) throw new NotFoundProblem()
      if (!(await this.tokens.revoke(orgId, id, actor.membershipId, now))) throw new ConflictProblem("This token is already revoked")
      await this.index.revoke(found.prefix, orgId, now)
      await this.quota.release(orgId, "API_TOKENS")
      await this.audit.record(orgId, [
        {
          action: "TOKEN_REVOKED",
          entityType: "ApiToken",
          entityId: id,
          diff: { name: found.name, prefix: found.prefix },
        },
      ])
      return found.prefix
    })
    await this.lookup.invalidateToken(prefix)
    return this.one(orgId, id)
  }

  private async one(orgId: string, id: string): Promise<ApiToken> {
    const row = await this.tokens.find(orgId, id)
    if (row === null) throw new NotFoundProblem()
    return toApiToken(row, this.clock.now())
  }
}
