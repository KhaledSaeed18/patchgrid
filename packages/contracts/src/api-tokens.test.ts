import { describe, expect, it } from "vitest"

import { API_TOKEN_PATTERN, createApiTokenRequestSchema } from "./api-tokens.ts"

describe("an API token request", () => {
  const valid = {
    name: "Monitoring",
    role: "AGENT",
    scopes: ["tickets:write"],
    expiresInDays: 90,
  }

  it("takes a name, a role, offered scopes and an offered expiry", () => {
    expect(createApiTokenRequestSchema.safeParse(valid).success).toBe(true)
    expect(createApiTokenRequestSchema.safeParse({ ...valid, expiresInDays: null }).success).toBe(true)
  })

  it("refuses an admin role, a reserved or repeated scope, no scope, and an odd expiry", () => {
    for (const bad of [
      { ...valid, role: "ADMIN" },
      { ...valid, scopes: ["webhooks:write"] },
      { ...valid, scopes: ["tickets:read", "tickets:read"] },
      { ...valid, scopes: [] },
      { ...valid, expiresInDays: 7 },
      { ...valid, orgId: "01a139bc-24b6-76bd-9fb5-6e5266b190fd" },
    ]) {
      expect(createApiTokenRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  it("matches the shape a minted token has", () => {
    expect(API_TOKEN_PATTERN.test(`pg_abc123def456_${"A".repeat(43)}`)).toBe(true)
    expect(API_TOKEN_PATTERN.test(`pg_ABC123DEF456_${"A".repeat(43)}`)).toBe(false)
  })
})
