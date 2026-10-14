import { describe, expect, it } from "vitest"

import { grantFor, PERMISSIONS } from "./permissions.ts"
import { grantSupportRequestSchema, SUPPORT_READ_PERMISSIONS } from "./support.ts"

describe("a support session's permissions", () => {
  it("are an ADMIN's read permissions minus token:read — nothing that writes, nothing personal", () => {
    for (const permission of SUPPORT_READ_PERMISSIONS) expect(grantFor("ADMIN", permission), permission).not.toBe(false)
    const writes = /:(create|update|write|delete|assign|link|transition|invite|remove|disable|revoke|grant|publish|export|change|manage|transfer|cancel|promote|approve|watch|upload)/
    expect(SUPPORT_READ_PERMISSIONS.filter((p) => writes.test(p))).toEqual([])
    expect(SUPPORT_READ_PERMISSIONS).not.toContain("token:read")
    expect(SUPPORT_READ_PERMISSIONS.some((p) => p.startsWith("notification:") || p.startsWith("support:"))).toBe(false)
    // Internal notes and the audit log, on purpose (ADR-0020).
    expect(SUPPORT_READ_PERMISSIONS).toEqual(expect.arrayContaining(["comment:read_internal", "org:read_audit"]))
    expect(PERMISSIONS.length).toBeGreaterThan(SUPPORT_READ_PERMISSIONS.length)
  })

  it("are granted for at most 72 hours", () => {
    expect(grantSupportRequestSchema.safeParse({ hours: 72 }).success).toBe(true)
    expect(grantSupportRequestSchema.safeParse({ hours: 73 }).success).toBe(false)
    expect(grantSupportRequestSchema.safeParse({ hours: 0 }).success).toBe(false)
  })
})
