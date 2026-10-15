import { z } from "zod"

import { mfaVerifyRequestSchema, totpCodeSchema } from "./platform.ts"

/**
 * A member's second factor (ADR-0029, ADR-0045). The TOTP shapes themselves —
 * enrolment, confirmation, verification, recovery codes — are shared with the
 * platform credential and live in `platform.ts`; this file is what is specific
 * to members: the second step of login, self-service, and step-up.
 */

/** The second step of a member's login: the challenge cookie plus a code or a recovery code. */
export const mfaLoginRequestSchema = mfaVerifyRequestSchema

/** `GET /auth/mfa`: whether this account has a confirmed factor, and how many recovery codes are left. */
export const mfaStatusSchema = z.object({
  enrolled: z.boolean(),
  confirmedAt: z.iso.datetime().nullable(),
  recoveryCodesRemaining: z.int().nonnegative(),
})
export type MfaStatus = z.infer<typeof mfaStatusSchema>

/**
 * Turning the factor off, or replacing the recovery codes, takes a current
 * code — or a recovery code, for someone whose authenticator is gone. The
 * password alone never undoes a second factor (ADR-0029).
 */
export const mfaDisableRequestSchema = mfaVerifyRequestSchema
export const mfaRegenerateRecoveryRequestSchema = z.strictObject({ code: totpCodeSchema })

/** How long a step-up proof is good for (ADR-0029): five minutes, carried as a claim on the access token. */
export const STEP_UP_TTL_SECONDS = 5 * 60

/**
 * `POST /auth/step-up`: a fresh proof before an irreversible action. A code or
 * a recovery code when a factor is enrolled; the password only when none is —
 * a password can never stand in for a factor that exists.
 */
export const stepUpRequestSchema = z
  .strictObject({
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((v) => [v.code, v.recoveryCode, v.password].filter((x) => x !== undefined).length === 1, {
    error: "send a code, a recovery code or the password",
  })
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>

export const stepUpResponseSchema = z.object({ stepUpExpiresAt: z.iso.datetime() })
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>

/** The actions that demand a step-up, whatever the member's factor policy (ADR-0029). */
export const STEP_UP_ACTIONS = ["org:delete", "org:transfer_ownership", "support:grant_access", "token:create"] as const
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number]
