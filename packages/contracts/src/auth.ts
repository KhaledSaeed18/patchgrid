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
 * Length only, no composition rules (NIST 800-63B, ADR-0032): a minimum long enough to
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
  /** When a workspace pending deletion is purged; its owners can cancel until then (ADR-0043). */
  purgeAt: z.iso.datetime().nullable(),
})
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>

export const sessionUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  name: z.string(),
})

export const signedInResponseSchema = z.object({
  status: z.literal("signed-in"),
  user: sessionUserSchema,
  workspaces: z.array(workspaceSummarySchema),
  /** The workspace whose cookie pair this response set, when `slug` was given and admitted. */
  session: z.object({ slug: slugSchema }).nullable(),
})
export type SignedInResponse = z.infer<typeof signedInResponseSchema>

/**
 * The kinds of second factor a person holds (ADR-0053): an authenticator
 * app, passkeys, or both. Here rather than beside the passkey shapes, which
 * import the platform's, which import this file.
 */
export const factorMethodSchema = z.enum(["totp", "passkey"])
export type FactorMethod = z.infer<typeof factorMethodSchema>

/**
 * The password was right and a second factor is held (ADR-0045): no session
 * yet, only a five-minute challenge cookie that `POST /auth/mfa` completes.
 * `methods` names the kinds the person holds (ADR-0053) — it reaches only
 * someone who typed the right password, so it tells them nothing the password
 * did not. Nothing else about the account is disclosed before the factor.
 */
export const mfaRequiredResponseSchema = z.object({ status: z.literal("mfa-required"), methods: z.array(factorMethodSchema).min(1) })

export const loginResponseSchema = z.discriminatedUnion("status", [signedInResponseSchema, mfaRequiredResponseSchema])
export type LoginResponse = z.infer<typeof loginResponseSchema>

/**
 * `GET /auth/identity` — the `pg_id` holder and the workspaces the picker
 * lists. Display only: entering one re-reads the membership (ADR-0031).
 */
export const identityResponseSchema = z.object({
  user: sessionUserSchema,
  workspaces: z.array(workspaceSummarySchema),
  /** Whether any second factor exists, TOTP or passkey — the picker routes to setup when a workspace demands one. */
  mfa: z.object({ enrolled: z.boolean() }),
  /**
   * The workspace whose identity provider started this session (ADR-0054), or
   * `null` for a session started with Patchgrid credentials. An SSO session
   * opens that workspace and no other.
   */
  sso: z.object({ slug: slugSchema }).nullable(),
})
export type IdentityResponse = z.infer<typeof identityResponseSchema>

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

/**
 * Signup answers `202` whether or not the address has an account; the inbox
 * gets "verify your address" or "you already have an account" (ADR-0031).
 */
export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
})
export type SignupRequest = z.infer<typeof signupRequestSchema>

/** Random 256-bit secrets, base64url: 43 characters, never anything else. */
export const secretTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, { error: "is not a valid token" })

/** The emailed link completes signup and starts the session (TENANCY.md §4). */
export const verifyEmailRequestSchema = z.object({ token: secretTokenSchema })

export const resendVerificationRequestSchema = z.object({ email: emailSchema })

export const passwordResetRequestSchema = z.object({ email: emailSchema })

export const passwordResetConfirmSchema = z.object({
  token: secretTokenSchema,
  password: passwordSchema,
})

/** Authenticated by `pg_id`; revokes every session, this one included (ADR-0031). */
export const changePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: passwordSchema })
  .refine((value) => value.currentPassword !== value.newPassword, {
    error: "must differ from the current password",
    path: ["newPassword"],
  })
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>
