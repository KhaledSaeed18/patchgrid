import { Injectable } from "@nestjs/common"
import {
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
    @InjectClock() private readonly clock: Clock,
  ) {}

  async get(): Promise<OrganizationSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_settings")
    const orgId = this.tenant.requireOrgId()
    const [record, lastRelease] = await Promise.all([this.settings.find(orgId), this.settings.lastSlugRelease(orgId)])
    if (record === null) throw new NotFoundProblem()
    return toSettings(record, this.nextSlugChange(lastRelease))
  }

  /** What the plan allows and what is used — the usage panel and the over-limit banner (TENANCY.md §8). */
  async usage(): Promise<Usage> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:read_settings")
    return this.quota.usage(this.tenant.requireOrgId())
  }

  async update(request: UpdateOrganizationSettingsRequest): Promise<OrganizationSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:update_settings")
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
    if (request.agentVisibility !== undefined && request.agentVisibility !== before.agentVisibility) {
      await this.lookup.invalidate({ id: orgId, slug: before.slug })
    }
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
    const set = await this.sessions.open(actor.userId, slug, client)
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
  }
}

function toSettings(record: OrganizationSettingsRecord, slugChangeAvailableAt: Date | null): OrganizationSettings {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    plan: record.plan,
    domain: record.domain,
    agentVisibility: record.agentVisibility,
    emailNotificationsEnabled: record.emailNotificationsEnabled,
    slugChangeAvailableAt: slugChangeAvailableAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  }
}
