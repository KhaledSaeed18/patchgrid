import { Injectable, Logger } from "@nestjs/common"
import { organizationStatusSchema, planSchema, agentVisibilitySchema, idSchema, slugSchema } from "@patchgrid/contracts"
import { z } from "zod"

import { ApiTokenIndexRepository } from "../platform/repositories/api-token-index.repository"
import {
  OrganizationRepository,
  type OrganizationSummary,
} from "../platform/repositories/organization.repository"
import { RedisService } from "../redis/redis.service"
import type { OrganizationLookup } from "./organization-lookup"

/**
 * Read-through cache over the platform repositories (ADR-0014: "cached in
 * Redis for 60 s"). Every request resolves a tenant, so this is the hottest
 * read in the system.
 *
 * Rules that keep it honest:
 * - Redis is a cache, never a source of truth. Any Redis failure logs and falls
 *   through to Postgres; an outage slows resolution, it never changes an answer.
 * - A slug maps to an id, and the id maps to the summary. One summary per org
 *   means `invalidate(org)` has one thing to delete — plus the slug pointers.
 * - Negative answers are cached briefly, so an unknown-slug flood costs one
 *   database read per ten seconds rather than one per request. Throttling
 *   (pipeline step 3) is the real defence; this is cheapness.
 * - Whoever changes a slug, status, plan or agent visibility calls
 *   `invalidate`. The TTL bounds the damage if they forget.
 */
@Injectable()
export class OrganizationLookupService implements OrganizationLookup {
  static readonly TTL_SECONDS = 60
  static readonly NEGATIVE_TTL_SECONDS = 10
  private static readonly MISSING = "-"

  private readonly logger = new Logger(OrganizationLookupService.name)

  constructor(
    private readonly redis: RedisService,
    private readonly organizations: OrganizationRepository,
    private readonly tokens: ApiTokenIndexRepository,
  ) {}

  async byId(id: string): Promise<OrganizationSummary | null> {
    return this.cached(keys.org(id), summarySchema, () => this.organizations.findSummaryById(id))
  }

  async bySlug(slug: string): Promise<OrganizationSummary | null> {
    const id = await this.cached(keys.slug(slug), idSchema, async () => {
      const org = await this.organizations.findSummaryBySlug(slug)
      if (org === null) return null
      // The summary read is already paid for; prime its slot too.
      await this.store(keys.org(org.id), org, OrganizationLookupService.TTL_SECONDS)
      return org.id
    })
    if (id === null) return null
    const org = await this.byId(id)
    // A stale slug pointer after a slug change: the org exists, but not here.
    return org !== null && org.slug === slug ? org : null
  }

  async orgIdForTokenPrefix(prefix: string): Promise<string | null> {
    return this.cached(keys.token(prefix), idSchema, async () => {
      const row = await this.tokens.findByPrefix(prefix)
      return row === null || row.revokedAt !== null ? null : row.orgId
    })
  }

  async retiredSlug(slug: string, now: Date): Promise<{ orgId: string } | null> {
    // Rare (only old bookmarks arrive here) and time-dependent; not cached.
    const retired = await this.organizations.findRetiredSlug(slug)
    if (retired === null || retired.redirectUntil.getTime() <= now.getTime()) return null
    return { orgId: retired.orgId }
  }

  /** Call after any change to slug, status, plan or agent visibility. */
  async invalidate(org: { id: string; slug: string; previousSlug?: string }): Promise<void> {
    const slugKeys = [keys.slug(org.slug)]
    if (org.previousSlug !== undefined) slugKeys.push(keys.slug(org.previousSlug))
    await this.redisOrNothing(() => this.redis.client.del(keys.org(org.id), ...slugKeys))
  }

  /** Call when a token is revoked, so the prefix stops resolving at once. */
  async invalidateToken(prefix: string): Promise<void> {
    await this.redisOrNothing(() => this.redis.client.del(keys.token(prefix)))
  }

  private async cached<T>(
    key: string,
    schema: z.ZodType<T>,
    load: () => Promise<T | null>,
  ): Promise<T | null> {
    const hit = await this.redisOrNothing(() => this.redis.client.get(key))
    if (hit === OrganizationLookupService.MISSING) return null
    if (hit !== null && hit !== undefined) {
      const parsed = schema.safeParse(JSON.parse(hit))
      if (parsed.success) return parsed.data
      // A cache entry we no longer understand is a deploy artefact, not a fact.
      await this.redisOrNothing(() => this.redis.client.del(key))
    }

    const value = await load()
    if (value === null) {
      await this.redisOrNothing(() =>
        this.redis.client.set(
          key,
          OrganizationLookupService.MISSING,
          "EX",
          OrganizationLookupService.NEGATIVE_TTL_SECONDS,
        ),
      )
      return null
    }
    await this.store(key, value, OrganizationLookupService.TTL_SECONDS)
    return value
  }

  private store(key: string, value: unknown, ttl: number): Promise<unknown> {
    return this.redisOrNothing(() => this.redis.client.set(key, JSON.stringify(value), "EX", ttl))
  }

  private async redisOrNothing<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation()
    } catch (error) {
      this.logger.warn(
        `tenant cache unavailable, reading through: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

const keys = {
  org: (id: string) => `tenant:org:${id}`,
  slug: (slug: string) => `tenant:slug:${slug}`,
  token: (prefix: string) => `tenant:token:${prefix}`,
}

const summarySchema: z.ZodType<OrganizationSummary> = z.object({
  id: idSchema,
  slug: slugSchema,
  status: organizationStatusSchema,
  plan: planSchema,
  agentVisibility: agentVisibilitySchema,
})
