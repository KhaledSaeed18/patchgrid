import { z } from "zod"

import { idSchema } from "./id.ts"
import { totpCodeSchema } from "./platform.ts"
import { slugSchema } from "./slug.ts"

/**
 * Passkeys (ADR-0053): WebAuthn credentials a member signs in with, alone or
 * as the second step, and proves a step-up with. The ceremony shapes mirror
 * the JSON the browser's WebAuthn API speaks, narrowed to what Patchgrid
 * sends and bounded so a request body cannot be made arbitrarily large.
 *
 * Every ceremony is two calls: options, which carry a challenge kept by the
 * API under `challengeId`, then the browser's answer to that challenge.
 */

/** Unpadded base64url, as WebAuthn's JSON encodes every byte string. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, { error: "must be base64url" })

export const PASSKEY_LABEL_MAX_LENGTH = 64
export const passkeyLabelSchema = z.string().trim().min(1).max(PASSKEY_LABEL_MAX_LENGTH)

/** A ceremony's challenge is kept for this long, then refused (ADR-0053). */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60

const transportSchema = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])
const userVerificationSchema = z.enum(["required", "preferred", "discouraged"])
const hintSchema = z.enum(["hybrid", "security-key", "client-device"])

const credentialDescriptorSchema = z.object({
  id: base64url(1024),
  type: z.literal("public-key"),
  transports: z.array(transportSchema).exactOptional(),
})

/**
 * `navigator.credentials.create()`'s options, as JSON. Optional fields are
 * exactly optional — absent, never `undefined` — as the browser's WebAuthn
 * types expect and as JSON carries them.
 */
export const passkeyCreationOptionsSchema = z.object({
  rp: z.object({ id: z.string().exactOptional(), name: z.string() }),
  user: z.object({ id: base64url(128), name: z.string(), displayName: z.string() }),
  challenge: base64url(128),
  pubKeyCredParams: z.array(z.object({ alg: z.int(), type: z.literal("public-key") })),
  timeout: z.int().positive().exactOptional(),
  excludeCredentials: z.array(credentialDescriptorSchema).exactOptional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.enum(["platform", "cross-platform"]).exactOptional(),
      requireResidentKey: z.boolean().exactOptional(),
      residentKey: z.enum(["discouraged", "preferred", "required"]).exactOptional(),
      userVerification: userVerificationSchema.exactOptional(),
    })
    .exactOptional(),
  hints: z.array(hintSchema).exactOptional(),
  attestation: z.enum(["direct", "enterprise", "indirect", "none"]).exactOptional(),
})
export type PasskeyCreationOptions = z.infer<typeof passkeyCreationOptionsSchema>

/** `navigator.credentials.get()`'s options, as JSON. */
export const passkeyRequestOptionsSchema = z.object({
  challenge: base64url(128),
  timeout: z.int().positive().exactOptional(),
  rpId: z.string().exactOptional(),
  allowCredentials: z.array(credentialDescriptorSchema).exactOptional(),
  userVerification: userVerificationSchema.exactOptional(),
  hints: z.array(hintSchema).exactOptional(),
})
export type PasskeyRequestOptions = z.infer<typeof passkeyRequestOptionsSchema>

export const passkeyCreationCeremonySchema = z.object({ challengeId: z.uuid(), options: passkeyCreationOptionsSchema })
export type PasskeyCreationCeremony = z.infer<typeof passkeyCreationCeremonySchema>

export const passkeyRequestCeremonySchema = z.object({ challengeId: z.uuid(), options: passkeyRequestOptionsSchema })
export type PasskeyRequestCeremony = z.infer<typeof passkeyRequestCeremonySchema>

/** What the browser answers a creation with. Unknown fields are dropped, not refused: browsers add them. */
export const passkeyRegistrationCredentialSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.object({}),
  response: z.object({
    clientDataJSON: base64url(4096),
    attestationObject: base64url(32768),
    authenticatorData: base64url(32768).optional(),
    // Not the enum: a browser may report a transport newer than this list, and it is only a hint.
    transports: z.array(z.string().max(32)).max(16).optional(),
    publicKeyAlgorithm: z.int().optional(),
    publicKey: base64url(4096).optional(),
  }),
})
export type PasskeyRegistrationCredential = z.infer<typeof passkeyRegistrationCredentialSchema>

/** What the browser answers a request with: the signed assertion. */
export const passkeyAssertionCredentialSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.object({}),
  response: z.object({
    clientDataJSON: base64url(4096),
    authenticatorData: base64url(32768),
    signature: base64url(1024),
    userHandle: base64url(128).optional(),
  }),
})
export type PasskeyAssertionCredential = z.infer<typeof passkeyAssertionCredentialSchema>

/** A passkey assertion as a proof: the challenge it answers, and the answer. */
export const passkeyProofSchema = z.strictObject({ challengeId: z.uuid(), credential: passkeyAssertionCredentialSchema })
export type PasskeyProof = z.infer<typeof passkeyProofSchema>

const recoveryCodeSchema = z.string().trim().min(8).max(32)

const exactlyOne = (fields: readonly unknown[]) => fields.filter((x) => x !== undefined).length === 1

/**
 * A member's factor, proved (ADR-0045, widened by ADR-0053): a code, a
 * recovery code, or a passkey — exactly one. The second step of login,
 * turning TOTP off and removing a passkey all take this. The platform's own
 * verify schema stays code-or-recovery: operators never use a passkey.
 */
export const memberFactorProofSchema = z
  .strictObject({ code: totpCodeSchema.optional(), recoveryCode: recoveryCodeSchema.optional(), passkey: passkeyProofSchema.optional() })
  .refine((v) => exactlyOne([v.code, v.recoveryCode, v.passkey]), { error: "send a code, a recovery code or a passkey" })
export type MemberFactorProof = z.infer<typeof memberFactorProofSchema>

/**
 * A fresh proof of the holder, by the step-up rule (ADR-0045, ADR-0053): a
 * factor when the person holds one, the password only when they hold none.
 * Adding a factor of either kind takes it — a `pg_id` alone, or a password
 * alone beside an existing factor, must not be able to add one of its own.
 */
export const holderProofSchema = z
  .strictObject({
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
    passkey: passkeyProofSchema.optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .refine((v) => exactlyOne([v.code, v.recoveryCode, v.passkey, v.password]), {
    error: "send a code, a recovery code, a passkey or the password",
  })
export type HolderProof = z.infer<typeof holderProofSchema>

export const passkeyRegistrationOptionsRequestSchema = holderProofSchema

export const passkeyRegisterRequestSchema = z.strictObject({
  challengeId: z.uuid(),
  credential: passkeyRegistrationCredentialSchema,
  label: passkeyLabelSchema,
})
export type PasskeyRegisterRequest = z.infer<typeof passkeyRegisterRequestSchema>

/** One passkey, as its owner's account page lists it. The credential itself never leaves the server. */
export const passkeySchema = z.object({
  id: idSchema,
  label: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** Synced to a provider's keychain rather than bound to one device. */
  synced: z.boolean(),
})
export type Passkey = z.infer<typeof passkeySchema>

/**
 * A factor was added. Recovery codes come with a person's **first** factor of
 * any kind and are shown once; adding a second keeps the codes they have, so
 * this is `null` then (ADR-0053).
 */
export const factorAddedSchema = z.object({ recoveryCodes: z.array(z.string()).length(10).nullable() })
export type FactorAdded = z.infer<typeof factorAddedSchema>

export const passkeyRegisteredSchema = factorAddedSchema.extend({ passkey: passkeySchema })
export type PasskeyRegistered = z.infer<typeof passkeyRegisteredSchema>

export const passkeyRenameRequestSchema = z.strictObject({ label: passkeyLabelSchema })

/** `POST /auth/passkeys/login`: the assertion stands for both factors, and optionally names a workspace to open. */
export const passkeyLoginRequestSchema = z.strictObject({
  challengeId: z.uuid(),
  credential: passkeyAssertionCredentialSchema,
  slug: slugSchema.optional(),
})
export type PasskeyLoginRequest = z.infer<typeof passkeyLoginRequestSchema>
