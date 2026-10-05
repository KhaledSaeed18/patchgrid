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
