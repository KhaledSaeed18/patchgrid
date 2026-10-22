import { describe, expect, it } from "vitest"

import { mfaDisableRequestSchema, mfaEnrolRequestSchema, mfaRegenerateRecoveryRequestSchema, stepUpRequestSchema } from "./mfa.ts"
import {
  memberFactorProofSchema,
  passkeyAssertionCredentialSchema,
  passkeyLoginRequestSchema,
  passkeyRegisterRequestSchema,
  passkeyRegistrationOptionsRequestSchema,
} from "./passkeys.ts"
import { mfaVerifyRequestSchema } from "./platform.ts"

const challengeId = "01939f4e-6d4e-7c1a-9a0e-3c1e4b6f8a21"
const assertion = {
  id: "Y3JlZGVudGlhbA",
  rawId: "Y3JlZGVudGlhbA",
  type: "public-key",
  clientExtensionResults: {},
  response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "c2ln", userHandle: "dXNlcg" },
} as const
const passkey = { challengeId, credential: assertion }

describe("a member's factor proof", () => {
  it("is exactly one of a code, a recovery code or a passkey", () => {
    expect(memberFactorProofSchema.safeParse({ code: "123456" }).success).toBe(true)
    expect(memberFactorProofSchema.safeParse({ recoveryCode: "abcde-fghij" }).success).toBe(true)
    expect(memberFactorProofSchema.safeParse({ passkey }).success).toBe(true)
    expect(memberFactorProofSchema.safeParse({}).success).toBe(false)
    expect(memberFactorProofSchema.safeParse({ code: "123456", passkey }).success).toBe(false)
    expect(memberFactorProofSchema.safeParse({ password: "hunter2hunter2" }).success).toBe(false)
  })

  it("is what turning the authenticator app off takes", () => {
    expect(mfaDisableRequestSchema.safeParse({ passkey }).success).toBe(true)
    expect(mfaDisableRequestSchema.safeParse({ password: "hunter2hunter2" }).success).toBe(false)
  })

  it("replaces the recovery codes with a live factor, never a recovery code", () => {
    expect(mfaRegenerateRecoveryRequestSchema.safeParse({ code: "123456" }).success).toBe(true)
    expect(mfaRegenerateRecoveryRequestSchema.safeParse({ passkey }).success).toBe(true)
    expect(mfaRegenerateRecoveryRequestSchema.safeParse({ recoveryCode: "abcde-fghij" }).success).toBe(false)
    expect(mfaRegenerateRecoveryRequestSchema.safeParse({ code: "123456", passkey }).success).toBe(false)
  })

  it("proves a step-up", () => {
    expect(stepUpRequestSchema.safeParse({ slug: "acme", passkey }).success).toBe(true)
    expect(stepUpRequestSchema.safeParse({ slug: "acme", passkey, password: "hunter2hunter2" }).success).toBe(false)
  })

  it("never reaches the platform's verify schema: operators do not use passkeys", () => {
    expect(mfaVerifyRequestSchema.safeParse({ passkey }).success).toBe(false)
  })
})

describe("registration", () => {
  it("starts from one proof, the password included, as setting up the authenticator app does", () => {
    expect(mfaEnrolRequestSchema.safeParse({ password: "hunter2hunter2" }).success).toBe(true)
    expect(mfaEnrolRequestSchema.safeParse({ passkey }).success).toBe(true)
    expect(passkeyRegistrationOptionsRequestSchema.safeParse({ password: "hunter2hunter2" }).success).toBe(true)
    expect(passkeyRegistrationOptionsRequestSchema.safeParse({ passkey }).success).toBe(true)
    expect(passkeyRegistrationOptionsRequestSchema.safeParse({}).success).toBe(false)
    expect(passkeyRegistrationOptionsRequestSchema.safeParse({ code: "123456", password: "hunter2hunter2" }).success).toBe(false)
  })

  it("takes a label that is not blank", () => {
    const credential = {
      id: "Y3JlZA",
      rawId: "Y3JlZA",
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: "e30", attestationObject: "o2Nm", transports: ["internal", "something-new"] },
    }
    expect(passkeyRegisterRequestSchema.safeParse({ challengeId, credential, label: "Laptop" }).success).toBe(true)
    expect(passkeyRegisterRequestSchema.safeParse({ challengeId, credential, label: "   " }).success).toBe(false)
    expect(passkeyRegisterRequestSchema.safeParse({ challengeId, credential, label: "x".repeat(65) }).success).toBe(false)
  })
})

describe("the assertion", () => {
  it("is base64url throughout, and bounded", () => {
    expect(passkeyAssertionCredentialSchema.safeParse(assertion).success).toBe(true)
    expect(passkeyAssertionCredentialSchema.safeParse({ ...assertion, response: { ...assertion.response, signature: "c2ln==" } }).success).toBe(false)
    expect(passkeyAssertionCredentialSchema.safeParse({ ...assertion, response: { ...assertion.response, signature: "a".repeat(1025) } }).success).toBe(false)
    expect(passkeyAssertionCredentialSchema.safeParse({ ...assertion, type: "password" }).success).toBe(false)
  })

  it("signs in alone, optionally naming a workspace", () => {
    expect(passkeyLoginRequestSchema.safeParse({ challengeId, credential: assertion }).success).toBe(true)
    expect(passkeyLoginRequestSchema.safeParse({ challengeId, credential: assertion, slug: "acme" }).success).toBe(true)
    expect(passkeyLoginRequestSchema.safeParse({ challengeId: "nope", credential: assertion }).success).toBe(false)
  })
})
