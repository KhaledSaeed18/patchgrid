import { Injectable } from "@nestjs/common"
import {
  inboundAddress,
  type ChangeSlugResponse,
  type OrganizationSettings,
  SLUG_CHANGE_COOLDOWN_DAYS,
  SLUG_REDIRECT_DAYS,
  type UpdateOrganizationSettingsRequest,
  type Usage,
} from "@patchgrid/contracts"

import { ActorService } from "../../auth/actor"
import type { CookieName, CookieSpec } from "../../auth/cookies"
import { CookieService } from "../../auth/cookies"
import { type ClientInfo, SessionService } from "../../auth/sessions/session.service"
import { type AuditEntry, AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { ConflictProblem, NotFoundProblem } from "../../common/problems/problem.exception"
import { PrismaService } from "../../prisma/prisma.service"
import { QuotaService } from "../../quota/quota.service"
import { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import {
  type OrganizationSettingsRecord,
  OrganizationSettingsRepository,
} from "../repositories/organization-settings.repository"
import { SlugRegistryRepository } from "../repositories/slug-registry.repository"

const DAY = 86_400_000

/**
 * The current organization's settings (RBAC.md §6, TENANCY.md §2).
 *
 * Every change commits with its audit row and its mirror in the picker's
 * projection; the cached organization summary is invalidated after commit,
 * because resolution reads `agentVisibility` and the slug from it.
 */
@Injectable()
export class OrgSettingsService {
  constructor(
    private readonly settings: OrganizationSettingsRepository,
    private readonly slugs: SlugRegistryRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lookup: OrganizationLookupService,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    private readonly quota: QuotaService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async get(): Promise<OrganizationSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_settings")
    const orgId = this.tenant.requireOrgId()
    const record = await this.settings.find(orgId)
    const lastRelease = await this.settings.lastSlugRelease(orgId)
    if (record === null) throw new NotFoundProblem()
    return toSettings(record, this.nextSlugChange(lastRelease), this.config.ROOT_DOMAIN)
  }

  /** What the plan allows and what is used — the usage panel and the over-limit banner (TENANCY.md §8). */
  async usage(): Promise<Usage> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_settings")
    return this.quota.usage(this.tenant.requireOrgId())
  }

  async update(request: UpdateOrganizationSettingsRequest): Promise<OrganizationSettings> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "org:update_settings")
    // Requiring a second factor of everyone is the owner's policy, whatever else the form carries (ADR-0029).
    if (request.requireMfa !== undefined) this.permissions.assert(actor, "org:require_mfa")
    const orgId = this.tenant.requireOrgId()
    const before = await this.prisma.transaction(async () => {
      const current = await this.settings.find(orgId)
      if (current === null) throw new NotFoundProblem()
      await this.settings.update(orgId, stripUndefined(request))
      if (request.name !== undefined && request.name !== current.name) {
        await this.settings.mirrorToPicker(orgId, { orgName: request.name })
      }
      await this.audit.record(orgId, auditFor(current, request))
      return current
    })
    // Resolution reads both from the cached summary: visibility for scoping, the MFA policy at open and refresh.
    const visibilityChanged = request.agentVisibility !== undefined && request.agentVisibility !== before.agentVisibility
    const policyChanged = request.requireMfa !== undefined && request.requireMfa !== before.requireMfa
    if (visibilityChanged || policyChanged) await this.lookup.invalidate({ id: orgId, slug: before.slug })
    return this.get()
  }

  /**
   * Owner only, at most once per cooldown. The old slug is retired forever and
   * redirects for a window; both slugs are locked so a concurrent claimant of
   * either serialises behind this change. The response re-mints the caller's
   * session under the new cookie name and clears the old pair (TENANCY.md §6);
   * everyone else re-enters through the picker.
   */
  async changeSlug(
    slug: string,
    client: ClientInfo,
  ): Promise<{ response: ChangeSlugResponse; set: CookieSpec[]; clear: CookieName[] }> {
    const actor = this.actors.requireMember()
    this.permissions.assert(actor, "org:change_slug")
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const redirectUntil = new Date(now.getTime() + SLUG_REDIRECT_DAYS * DAY)

    const previousSlug = await this.prisma.transaction(async () => {
      const current = await this.settings.find(orgId)
      if (current === null) throw new NotFoundProblem()
      await this.slugs.lock(current.slug, slug)
      // Another owner may have moved it between the read and the lock.
      if ((await this.settings.find(orgId))?.slug !== current.slug) {
        throw new ConflictProblem("The workspace address just changed; reload and try again")
      }
      if (slug === current.slug) throw new ConflictProblem("That is already this workspace's address")

      const next = this.nextSlugChange(await this.settings.lastSlugRelease(orgId))
      if (next !== null) {
        throw new ConflictProblem(`The address can change again on ${next.toISOString().slice(0, 10)}`)
      }
      if (await this.slugs.isTaken(slug)) throw new ConflictProblem("That workspace address is taken")

      await this.settings.retireSlug(orgId, current.slug, now, redirectUntil)
      await this.settings.setSlug(orgId, slug)
      await this.settings.mirrorToPicker(orgId, { orgSlug: slug })
      await this.audit.record(orgId, [
        { action: "ORG_SLUG_CHANGED", entityType: "Organization", entityId: orgId, diff: { slug: { from: current.slug, to: slug } } },
      ])
      return current.slug
    })

    // Both pointers: a cached "unknown" for the new slug, a cached org for the old.
    await this.lookup.invalidate({ id: orgId, slug, previousSlug })
    // An SSO session stays one under the new name (ADR-0054).
    const set = await this.sessions.open(actor.userId, slug, client, { ssoOrgId: actor.viaSso === true ? orgId : null })
    return {
      response: { slug, previousSlug, redirectUntil: redirectUntil.toISOString(), session: { slug } },
      set,
      clear: this.cookies.pairOf(previousSlug),
    }
  }

  private nextSlugChange(lastRelease: Date | null): Date | null {
    if (lastRelease === null) return null
    const next = new Date(lastRelease.getTime() + SLUG_CHANGE_COOLDOWN_DAYS * DAY)
    return next.getTime() > this.clock.now().getTime() ? next : null
  }
}

/** Agent visibility gets its own action: it changes who sees which tickets (RBAC.md §4). */
function auditFor(before: OrganizationSettingsRecord, request: UpdateOrganizationSettingsRequest): AuditEntry[] {
  const entries: AuditEntry[] = []
  const diff: Record<string, { from: unknown; to: unknown }> = {}
  if (request.name !== undefined && request.name !== before.name) diff.name = { from: before.name, to: request.name }
  if (request.emailNotificationsEnabled !== undefined && request.emailNotificationsEnabled !== before.emailNotificationsEnabled) {
    diff.emailNotificationsEnabled = { from: before.emailNotificationsEnabled, to: request.emailNotificationsEnabled }
  }
  if (Object.keys(diff).length > 0) {
    entries.push({ action: "ORG_SETTINGS_UPDATED", entityType: "Organization", entityId: before.id, diff })
  }
  if (request.requireMfa !== undefined && request.requireMfa !== before.requireMfa) {
    entries.push({
      action: "ORG_MFA_REQUIREMENT_CHANGED",
      entityType: "Organization",
      entityId: before.id,
      diff: { requireMfa: { from: before.requireMfa, to: request.requireMfa } },
    })
  }
  if (request.agentVisibility !== undefined && request.agentVisibility !== before.agentVisibility) {
    entries.push({
      action: "AGENT_VISIBILITY_CHANGED",
      entityType: "Organization",
      entityId: before.id,
      diff: { agentVisibility: { from: before.agentVisibility, to: request.agentVisibility } },
    })
  }
  return entries
}

function stripUndefined(request: UpdateOrganizationSettingsRequest) {
  return {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.agentVisibility === undefined ? {} : { agentVisibility: request.agentVisibility }),
    ...(request.emailNotificationsEnabled === undefined
      ? {}
      : { emailNotificationsEnabled: request.emailNotificationsEnabled }),
    ...(request.requireMfa === undefined ? {} : { requireMfa: request.requireMfa }),
  }
}

function toSettings(record: OrganizationSettingsRecord, slugChangeAvailableAt: Date | null, rootDomain: string): OrganizationSettings {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    plan: record.plan,
    domain: record.domain,
    agentVisibility: record.agentVisibility,
    emailNotificationsEnabled: record.emailNotificationsEnabled,
    requireMfa: record.requireMfa,
    inboundAddress: inboundAddress(record.slug, rootDomain),
    slugChangeAvailableAt: slugChangeAvailableAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}
