import { describe, expect, it } from "vitest"

import {
  acceptNewInvitationRequestSchema,
  createInvitationRequestSchema,
  memberListQuerySchema,
} from "./memberships.ts"

describe("membership shapes", () => {
  it("hides removed members unless asked, and pages by default", () => {
    expect(memberListQuerySchema.parse({})).toEqual({ limit: 25, includeRemoved: false })
    expect(memberListQuerySchema.parse({ includeRemoved: "true", limit: "10" })).toEqual({ limit: 10, includeRemoved: true })
    expect(memberListQuerySchema.safeParse({ includeRemoved: "yes" }).success).toBe(false)
  })

  it("stores an invited address lower-cased, so the binding cannot be dodged by case", () => {
    expect(createInvitationRequestSchema.parse({ email: " Alice@Acme.COM ", role: "AGENT" }).email).toBe("alice@acme.com")
  })

  it("holds an account created through an invitation to the password policy", () => {
    const base = { token: "x.y", name: "Alice" }
    expect(acceptNewInvitationRequestSchema.safeParse({ ...base, password: "short" }).success).toBe(false)
    expect(acceptNewInvitationRequestSchema.safeParse({ ...base, password: "correct horse battery" }).success).toBe(true)
  })
})
