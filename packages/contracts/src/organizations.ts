import { z } from "zod"

import { idSchema } from "./id.ts"
import { type SlugRejection, slugSchema } from "./slug.ts"
import { agentVisibilitySchema, organizationStatusSchema, planSchema } from "./tenancy.ts"

/**
 * Workspaces (ADR-0017, TENANCY.md §4). Creation is tenant-less: the caller is
 * a `pg_id` holder and becomes the owner. The slug is the subdomain, validated
 * by the one schema the signup form and tenant resolution share.
 */

/** A claimed email domain; proving it is a later item. Stored lower-cased (the database checks). */
export const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
        error: "must be a domain name such as acme.com",
      }),
  )

export const createOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slugSchema,
  domain: emailDomainSchema.optional(),
})
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>

export const organizationSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: slugSchema,
  status: organizationStatusSchema,
  plan: planSchema,
})
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>

/** The new workspace, and the session the response set for it. */
export const createOrganizationResponseSchema = z.object({
  organization: organizationSummarySchema,
  session: z.object({ slug: slugSchema }),
})
export type CreateOrganizationResponse = z.infer<typeof createOrganizationResponseSchema>

/**
 * `GET /orgs/slug-available` — the live check behind the signup form. `reason`
 * names why not; `taken` covers a current slug and a retired one alike, since a
 * released slug is never reused (TENANCY.md §2).
 */
export const slugAvailabilitySchema = z.object({
  slug: z.string(),
  available: z.boolean(),
  reason: z.enum(["too-short", "too-long", "invalid-characters", "reserved", "taken"]).nullable(),
})
export type SlugAvailability = z.infer<typeof slugAvailabilitySchema>

/** The `reason` values are exactly `SlugRejection`; this fails to compile if they drift. */
const _reasonParity: SlugRejection = "taken" satisfies SlugAvailability["reason"]
void _reasonParity

/**
 * `GET /org/settings` — agents and above read it; admins change the mutable
 * part. `slugChangeAvailableAt` is when the owner may next change the slug
 * (TENANCY.md §2: at most once per 30 days), `null` when they may now.
 */
export const organizationSettingsSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: slugSchema,
  status: organizationStatusSchema,
  plan: planSchema,
  domain: z.string().nullable(),
  agentVisibility: agentVisibilitySchema,
  emailNotificationsEnabled: z.boolean(),
  slugChangeAvailableAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>

export const updateOrganizationSettingsRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    agentVisibility: agentVisibilitySchema,
    emailNotificationsEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: "must change at least one field" })
export type UpdateOrganizationSettingsRequest = z.infer<typeof updateOrganizationSettingsRequestSchema>

/** Owner only. The old slug 302-redirects for 30 days and is never reusable (TENANCY.md §2). */
export const changeSlugRequestSchema = z.object({ slug: slugSchema })
export type ChangeSlugRequest = z.infer<typeof changeSlugRequestSchema>

export const changeSlugResponseSchema = z.object({
  slug: slugSchema,
  previousSlug: slugSchema,
  redirectUntil: z.iso.datetime(),
  /** The workspace whose cookie pair this response set; the old slug's pair is cleared. */
  session: z.object({ slug: slugSchema }),
})
export type ChangeSlugResponse = z.infer<typeof changeSlugResponseSchema>
