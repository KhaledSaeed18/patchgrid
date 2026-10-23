import { describe, expect, it } from "vitest"

import { PERMISSION_MATRIX } from "./permissions.ts"
import { PROBLEM_TYPES } from "./problems.ts"
import {
  domainProofRecordName,
  domainProofRecordValue,
  orgDomainRequestSchema,
  ssoConnectionRequestSchema,
  ssoReturnPathSchema,
  ssoStartQuerySchema,
} from "./sso.ts"

describe("orgDomainRequestSchema", () => {
  it("takes a domain lower-cased, or null to remove it", () => {
    expect(orgDomainRequestSchema.parse({ domain: " Acme.TEST " })).toEqual({ domain: "acme.test" })
    expect(orgDomainRequestSchema.parse({ domain: null })).toEqual({ domain: null })
  })

  it("refuses a public mail provider: no workspace can prove gmail.com", () => {
    expect(orgDomainRequestSchema.safeParse({ domain: "gmail.com" }).success).toBe(false)
    expect(orgDomainRequestSchema.safeParse({ domain: "Outlook.com" }).success).toBe(false)
  })

  it("refuses what is not a domain", () => {
    expect(orgDomainRequestSchema.safeParse({ domain: "acme" }).success).toBe(false)
    expect(orgDomainRequestSchema.safeParse({ domain: "https://acme.com" }).success).toBe(false)
  })
})

describe("the domain proof", () => {
  it("is one TXT record under a name of our own", () => {
    expect(domainProofRecordName("acme.test")).toBe("_patchgrid-verify.acme.test")
    expect(domainProofRecordValue("abc")).toBe("patchgrid-verify=abc")
  })
})

describe("ssoConnectionRequestSchema", () => {
  const base = { issuer: "https://idp.acme.test/realms/acme", clientId: "patchgrid", defaultRole: "REQUESTER", enabled: true }

  it("leaves the secret out to keep the stored one", () => {
    expect(ssoConnectionRequestSchema.safeParse(base).success).toBe(true)
  })

  it("never provisions above an agent", () => {
    expect(ssoConnectionRequestSchema.safeParse({ ...base, defaultRole: "AGENT" }).success).toBe(true)
    expect(ssoConnectionRequestSchema.safeParse({ ...base, defaultRole: "ADMIN" }).success).toBe(false)
    expect(ssoConnectionRequestSchema.safeParse({ ...base, defaultRole: "OWNER" }).success).toBe(false)
  })

  it("takes only web URLs as the issuer", () => {
    expect(ssoConnectionRequestSchema.safeParse({ ...base, issuer: "file:///etc/passwd" }).success).toBe(false)
    expect(ssoConnectionRequestSchema.safeParse({ ...base, issuer: "javascript:alert(1)" }).success).toBe(false)
  })
})

describe("ssoStartQuerySchema", () => {
  it("names the workspace by email or by slug, never both or neither", () => {
    expect(ssoStartQuerySchema.parse({ email: "kim@acme.test" }).intent).toBe("sign-in")
    expect(ssoStartQuerySchema.safeParse({ slug: "acme" }).success).toBe(true)
    expect(ssoStartQuerySchema.safeParse({ email: "kim@acme.test", slug: "acme" }).success).toBe(false)
    expect(ssoStartQuerySchema.safeParse({}).success).toBe(false)
  })

  it("steps up only in a named workspace", () => {
    expect(ssoStartQuerySchema.safeParse({ email: "kim@acme.test", intent: "step-up" }).success).toBe(false)
    expect(ssoStartQuerySchema.safeParse({ slug: "acme", intent: "step-up" }).success).toBe(true)
  })
})

describe("ssoReturnPathSchema", () => {
  it("is a path on the same host and nothing that leaves it", () => {
    expect(ssoReturnPathSchema.safeParse("/queues?view=mine").success).toBe(true)
    expect(ssoReturnPathSchema.safeParse("//evil.example/").success).toBe(false)
    expect(ssoReturnPathSchema.safeParse("/\\evil.example").success).toBe(false)
    expect(ssoReturnPathSchema.safeParse("https://evil.example/").success).toBe(false)
    expect(ssoReturnPathSchema.safeParse("/a b").success).toBe(false)
  })
})

describe("the catalog", () => {
  it("keeps the domain and the connection with the owners", () => {
    for (const permission of ["org:manage_domain", "org:manage_sso"] as const) {
      expect(PERMISSION_MATRIX[permission]).toEqual({ REQUESTER: false, AGENT: false, ADMIN: false, OWNER: true })
    }
  })

  it("refuses an SSO problem as a 403 of its own", () => {
    expect(PROBLEM_TYPES["sso-required"].status).toBe(403)
    expect(PROBLEM_TYPES["sso-session-scoped"].status).toBe(403)
  })
})
