import { describe, expect, it } from "vitest"

import { emailSchema, loginRequestSchema, logoutRequestSchema, passwordSchema } from "./auth.ts"

describe("emailSchema", () => {
  it("normalises to lower case and trims", () => {
    expect(emailSchema.parse("  Owner@Acme.TEST ")).toBe("owner@acme.test")
  })

  it("rejects things that are not addresses", () => {
    expect(emailSchema.safeParse("owner").success).toBe(false)
    expect(emailSchema.safeParse(`${"a".repeat(250)}@x.io`).success).toBe(false)
  })
})

describe("passwordSchema", () => {
  it("is length-only", () => {
    expect(passwordSchema.safeParse("correct horse battery").success).toBe(true)
    expect(passwordSchema.safeParse("short").success).toBe(false)
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false)
  })
})

describe("loginRequestSchema", () => {
  it("does not apply the password policy to a login attempt", () => {
    expect(loginRequestSchema.safeParse({ email: "a@b.io", password: "x" }).success).toBe(true)
    expect(loginRequestSchema.safeParse({ email: "a@b.io", password: "" }).success).toBe(false)
  })

  it("validates the optional slug", () => {
    expect(loginRequestSchema.safeParse({ email: "a@b.io", password: "x", slug: "api" }).success).toBe(false)
  })
})

describe("logoutRequestSchema", () => {
  it("defaults to this workspace only", () => {
    expect(logoutRequestSchema.parse({ slug: "acme" })).toEqual({ slug: "acme", everywhere: false })
  })
})

describe("identity requests", () => {
  const token = "a".repeat(43)

  it("applies the password policy where a password is being set", async () => {
    const { signupRequestSchema, passwordResetConfirmSchema, changePasswordRequestSchema } = await import("./auth.ts")
    expect(signupRequestSchema.safeParse({ email: "a@b.io", password: "short", name: "Sam" }).success).toBe(false)
    expect(signupRequestSchema.safeParse({ email: "a@b.io", password: "correct horse battery", name: " Sam " }).success).toBe(true)
    expect(passwordResetConfirmSchema.safeParse({ token, password: "short" }).success).toBe(false)
    expect(changePasswordRequestSchema.safeParse({ currentPassword: "same same same", newPassword: "same same same" }).success).toBe(false)
  })

  it("accepts only the exact shape of a secret token", async () => {
    const { verifyEmailRequestSchema } = await import("./auth.ts")
    expect(verifyEmailRequestSchema.safeParse({ token }).success).toBe(true)
    expect(verifyEmailRequestSchema.safeParse({ token: "short" }).success).toBe(false)
    expect(verifyEmailRequestSchema.safeParse({ token: `${"a".repeat(42)}=` }).success).toBe(false)
  })
})
