import { Injectable, Logger } from "@nestjs/common"
import {
  checkSlugFormat,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type SlugAvailability,
} from "@patchgrid/contracts"
import { v7 as uuidv7 } from "uuid"

import type { CookieSpec } from "../../auth/cookies"
import { SessionService } from "../../auth/sessions/session.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotAuthenticatedProblem } from "../../common/problems/problem.exception"
import { UserRepository } from "../../platform/repositories/user.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import { OrganizationProvisioningRepository } from "../repositories/organization-provisioning.repository"

/** TENANCY.md §4. Categories, SLA policies and KB articles join when their tables exist (M2). */
export const DEFAULT_TEAMS = ["IT Support", "Network", "Security"] as const

/**
 * Workspace creation (ADR-0017). The caller is a verified `pg_id` holder and
 * becomes the owner. The org id is minted here, before anything exists, so the
 * whole transaction can run inside the new tenant's context — the first place
 * `runAsTenant` is used to WRITE, and the reason `src/orgs/provisioning` is on
 * its allow-list (ADR-0022).
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name)

  constructor(
    private readonly repository: OrganizationProvisioningRepository,
    private readonly users: UserRepository,
    private readonly lookup: OrganizationLookupService,
    private readonly sessions: SessionService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async availability(candidate: string): Promise<SlugAvailability> {
    const slug = candidate.trim().toLowerCase()
    const format = checkSlugFormat(slug)
    if (format !== null) return { slug, available: false, reason: format }
    const taken = await this.repository.isSlugTaken(slug)
    return { slug, available: !taken, reason: taken ? "taken" : null }
  }

  async create(
    userId: string,
    request: CreateOrganizationRequest,
    client: { userAgent: string | null; ip: string | null },
  ): Promise<{ response: CreateOrganizationResponse; cookies: CookieSpec[] }> {
    const account = await this.users.findById(userId)
    if (account === null || account.anonymisedAt !== null || account.emailVerifiedAt === null) {
      throw new NotAuthenticatedProblem("A verified account is required")
    }

    const orgId = uuidv7()
    const result = await runAsTenant(orgId, { actor: `user:${userId}`, reason: "provision workspace" }, () =>
      this.repository.provision({
        orgId,
        name: request.name,
        slug: request.slug,
        domain: request.domain ?? null,
        owner: { userId, displayName: account.name },
        teams: DEFAULT_TEAMS,
        now: this.clock.now(),
      }),
    )
    if (result.outcome === "slug-taken") throw new ConflictProblem("That workspace address is taken")

    // A probe of this slug may have cached "unknown" seconds ago.
    await this.lookup.invalidate({ id: orgId, slug: request.slug })
    this.logger.log({ msg: "workspace provisioned", orgId, ownerMembershipId: result.membershipId })

    const cookies = await this.sessions.open(userId, request.slug, client)
    return {
      response: {
        organization: { id: orgId, name: request.name, slug: request.slug, status: "ACTIVE", plan: "FREE" },
        session: { slug: request.slug },
      },
      cookies,
    }
  }
}
