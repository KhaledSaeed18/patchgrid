import { z } from "zod"

import { emailSchema } from "./auth.ts"
import { idSchema } from "./id.ts"

/**
 * The platform credential (ADR-0040): an operator's own login, a second
 * factor before any session, and a one-hour session that reaches only
 * `/api/v1/platform`. Nothing here grants tenant content.
 */

/** A server-side caller's statement that it speaks for the `admin.` surface; a browser sends `Origin`. */
export const SURFACE_HEADER = "x-patchgrid-surface"
export const ADMIN_SURFACE = "admin"

export const PLATFORM_SESSION_TTL_SECONDS = 60 * 60

export const platformLoginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(200),
})
export type PlatformLoginRequest = z.infer<typeof platformLoginRequestSchema>

/** What the password step leads to: a factor to verify, or one to enrol first. */
export const platformLoginStepSchema = z.object({ next: z.enum(["verify", "enrol"]) })
export type PlatformLoginStep = z.infer<typeof platformLoginStepSchema>

/** A new, unconfirmed TOTP factor: scan the URI, or type the secret. */
export const mfaEnrolmentSchema = z.object({ secret: z.string(), otpauthUri: z.string() })
export type MfaEnrolment = z.infer<typeof mfaEnrolmentSchema>

export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, { error: "must be the 6-digit code" })

/** A code from the authenticator, or one unused recovery code — exactly one of them. */
export const mfaVerifyRequestSchema = z
  .strictObject({
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), { error: "send a code or a recovery code" })
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>

export const mfaConfirmRequestSchema = z.strictObject({ code: totpCodeSchema })
export type MfaConfirmRequest = z.infer<typeof mfaConfirmRequestSchema>

/** Shown once, when a factor is confirmed. */
export const recoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()).length(10) })
export type RecoveryCodes = z.infer<typeof recoveryCodesSchema>

export const platformMeSchema = z.object({
  platformAdminId: idSchema,
  email: z.string(),
  name: z.string(),
  sessionExpiresAt: z.iso.datetime(),
})
export type PlatformMe = z.infer<typeof platformMeSchema>

/** What the platform's own log records (ADR-0040). */
export const platformAuditActionSchema = z.enum([
  "PLATFORM_ADMIN_GRANTED",
  "PLATFORM_ADMIN_REVOKED",
  "PLATFORM_SIGNED_IN",
  "PLATFORM_SIGNED_OUT",
  "PLATFORM_MFA_ENROLLED",
  "PLATFORM_RECOVERY_CODE_USED",
  "PLATFORM_ORG_SUSPENDED",
  "PLATFORM_ORG_UNSUSPENDED",
  "PLATFORM_ORG_PLAN_SET",
  "PLATFORM_ORG_DELETION_RESTORED",
])
export type PlatformAuditAction = z.infer<typeof platformAuditActionSchema>
