import { describe, expect, it } from "vitest"

import { loginResponseSchema } from "./auth.ts"
import { mfaDisableRequestSchema, STEP_UP_ACTIONS, stepUpRequestSchema } from "./mfa.ts"
import { PERMISSION_MATRIX } from "./permissions.ts"
import { PROBLEM_TYPES } from "./problems.ts"

describe("loginResponseSchema", () => {
  it("is either a session or a pending second factor, never both", () => {
    expect(loginResponseSchema.parse({ status: "mfa-required", methods: ["totp"] })).toEqual({ status: "mfa-required", methods: ["totp"] })
    expect(loginResponseSchema.safeParse({ status: "mfa-required", methods: [] }).success).toBe(false)
    const signedIn = {
      status: "signed-in",
      user: { id: "01939f4e-6d4e-7c1a-9a0e-3c1e4b6f8a21", email: "a@b.io", name: "A" },
      workspaces: [],
      session: null,
    }
    expect(loginResponseSchema.safeParse(signedIn).success).toBe(true)
    expect(loginResponseSchema.safeParse({ status: "mfa-required", methods: ["passkey"], user: signedIn.user }).success).toBe(true)
    expect(loginResponseSchema.safeParse({ user: signedIn.user, workspaces: [], session: null }).success).toBe(false)
  })
})

describe("stepUpRequestSchema", () => {
  it("names the workspace and takes exactly one proof", () => {
    expect(stepUpRequestSchema.safeParse({ slug: "acme", code: "123456" }).success).toBe(true)
    expect(stepUpRequestSchema.safeParse({ slug: "acme", password: "hunter2hunter2" }).success).toBe(true)
    expect(stepUpRequestSchema.safeParse({ slug: "acme", recoveryCode: "abcde-fghij" }).success).toBe(true)
    expect(stepUpRequestSchema.safeParse({ code: "123456" }).success).toBe(false)
    expect(stepUpRequestSchema.safeParse({ slug: "acme" }).success).toBe(false)
    expect(stepUpRequestSchema.safeParse({ slug: "acme", code: "123456", password: "x" }).success).toBe(false)
    expect(stepUpRequestSchema.safeParse({ slug: "acme", code: "12345" }).success).toBe(false)
  })
})

describe("mfaDisableRequestSchema", () => {
  it("never accepts a password: the factor is undone only by the factor or a recovery code", () => {
    expect(mfaDisableRequestSchema.safeParse({ password: "hunter2hunter2" }).success).toBe(false)
    expect(mfaDisableRequestSchema.safeParse({ recoveryCode: "abcde-fghij" }).success).toBe(true)
  })
})

describe("step-up", () => {
  it("names only permissions the matrix grants to owners or admins, never to a token-reachable family", () => {
    for (const action of STEP_UP_ACTIONS) {
      expect(PERMISSION_MATRIX[action].REQUESTER).toBe(false)
      expect(PERMISSION_MATRIX[action].AGENT).toBe(false)
    }
  })

  it("answers with a 403 that is not the plain not-permitted", () => {
    expect(PROBLEM_TYPES["step-up-required"].status).toBe(403)
    expect(PROBLEM_TYPES["mfa-required"].status).toBe(403)
  })
})
