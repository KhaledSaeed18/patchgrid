import { z } from "zod"

import { factorMethodSchema } from "./auth.ts"
import { holderProofSchema, memberFactorProofSchema, passkeyProofSchema } from "./passkeys.ts"
import { totpCodeSchema } from "./platform.ts"
import { slugSchema } from "./slug.ts"

/**
 * A member's second factor (ADR-0029, ADR-0045). The TOTP shapes themselves —
 * enrolment, confirmation, verification, recovery codes — are shared with the
 * platform credential and live in `platform.ts`; this file is what is specific
 * to members: the second step of login, self-service, and step-up.
 */

/** The second step of a member's login: the challenge cookie plus a code, a recovery code or a passkey (ADR-0053). */
export const mfaLoginRequestSchema = memberFactorProofSchema

/**
 * Setting up the authenticator app takes a fresh proof (ADR-0045 erratum, M9
 * review; ADR-0053): a `pg_id` is a long-lived bearer, and whoever held one
 * could otherwise enrol their own authenticator and lock the person out of
 * every workspace that requires one. With a passkey already held, the
 * password is not enough either: it would let a password thief add a factor
 * of their own beside it.
 */
export const mfaEnrolRequestSchema = holderProofSchema
export type MfaEnrolRequest = z.infer<typeof mfaEnrolRequestSchema>

/**
 * `GET /auth/mfa`: whether this account has a confirmed authenticator app,
 * which kinds of factor it holds at all, and how many recovery codes are
 * left — the codes belong to the person, not to one kind (ADR-0053).
 */
export const mfaStatusSchema = z.object({
  /** A confirmed authenticator app (TOTP). */
  enrolled: z.boolean(),
  confirmedAt: z.iso.datetime().nullable(),
  /** Every kind held; empty means the password is the only proof. */
  methods: z.array(factorMethodSchema),
  /** Whether the account has a password at all: one provisioned by SSO has none (ADR-0054). */
  password: z.boolean(),
  recoveryCodesRemaining: z.int().nonnegative(),
})
export type MfaStatus = z.infer<typeof mfaStatusSchema>

/**
 * Turning the authenticator app off takes a factor — a current code, a
 * passkey, or a recovery code for someone whose devices are gone. The
 * password alone never undoes a second factor (ADR-0029).
 */
export const mfaDisableRequestSchema = memberFactorProofSchema

/** Replacing the recovery codes takes a live factor, never a recovery code. */
export const mfaRegenerateRecoveryRequestSchema = z
  .strictObject({ code: totpCodeSchema.optional(), passkey: passkeyProofSchema.optional() })
  .refine((v) => (v.code === undefined) !== (v.passkey === undefined), { error: "send a code or a passkey" })

/** How long a step-up proof is good for (ADR-0029): five minutes, carried as a claim on the access token. */
export const STEP_UP_TTL_SECONDS = 5 * 60

/**
 * `POST /auth/step-up`: a fresh proof before an irreversible action. A code, a
 * passkey or a recovery code when a factor is held; the password only when
 * none is — a password can never stand in for a factor that exists.
 */
export const stepUpRequestSchema = z
  .strictObject({
    /** The workspace whose session is re-issued with the proof — tenant-less, as every auth route is. */
    slug: slugSchema,
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(8).max(32).optional(),
    passkey: passkeyProofSchema.optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((v) => [v.code, v.recoveryCode, v.passkey, v.password].filter((x) => x !== undefined).length === 1, {
    error: "send a code, a recovery code, a passkey or the password",
  })
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>

export const stepUpResponseSchema = z.object({ stepUpExpiresAt: z.iso.datetime() })
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>

/** The actions that demand a step-up, whatever the member's factor policy (ADR-0029). */
export const STEP_UP_ACTIONS = ["org:delete", "org:transfer_ownership", "org:manage_sso", "support:grant_access", "token:create"] as const
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number]
