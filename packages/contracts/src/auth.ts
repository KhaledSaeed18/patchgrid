import { z } from "zod"

import { idSchema } from "./id.ts"
import { slugSchema } from "./slug.ts"
import { membershipStatusSchema, organizationStatusSchema, roleSchema } from "./tenancy.ts"

/**
 * Identity and session shapes (ADR-0004, ADR-0024, ADR-0031).
 *
 * Every anonymous identity endpoint answers uniformly whether or not the
 * address exists; nothing in these shapes may vary with that fact.
 */

/** Stored and compared lower-cased; the database refuses anything else. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "must be an email address" }).max(254))

/**
 * Length only, no composition rules (NIST 800-63B): a minimum long enough to
 * resist online guessing behind the throttle, a maximum so Argon2id's cost is
 * bounded. Breached-password screening is a later item.
 */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `must be at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { error: `must be at most ${PASSWORD_MAX_LENGTH} characters` })

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: a too-short password on LOGIN is simply wrong, and
  // saying "too short" instead of "invalid" is a small oracle on the policy.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** Mint this workspace's cookie pair in the same response, if the user is a member. */
  slug: slugSchema.optional(),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

/** One row of the org picker, from `UserOrgIndex` — display only, never authorization (ADR-0022). */
export const workspaceSummarySchema = z.object({
  orgId: idSchema,
  slug: slugSchema,
  name: z.string(),
  role: roleSchema,
  status: membershipStatusSchema,
  orgStatus: organizationStatusSchema,
})
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>

export const sessionUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  name: z.string(),
})

export const loginResponseSchema = z.object({
  user: sessionUserSchema,
  workspaces: z.array(workspaceSummarySchema),
  /** The workspace whose cookie pair this response set, when `slug` was given and admitted. */
  session: z.object({ slug: slugSchema }).nullable(),
})
export type LoginResponse = z.infer<typeof loginResponseSchema>

/** The org switcher: mint a pair for one workspace the `pg_id` holder belongs to. */
export const openSessionRequestSchema = z.object({ slug: slugSchema })
export const openSessionResponseSchema = z.object({ session: z.object({ slug: slugSchema }) })

/** Rotate `pg_rt_<slug>`; the slug names the cookie because the route is tenant-less. */
export const refreshRequestSchema = z.object({ slug: slugSchema })

export const logoutRequestSchema = z.object({
  /** Clear this workspace's pair. Omitted with `everywhere: false` clears nothing but is not an error. */
  slug: slugSchema.optional(),
  /** Revoke every session of this user, in every workspace, and `pg_id` (ADR-0024). */
  everywhere: z.boolean().default(false),
})
export type LogoutRequest = z.infer<typeof logoutRequestSchema>
