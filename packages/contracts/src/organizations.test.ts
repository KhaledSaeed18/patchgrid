import { describe, expect, it } from "vitest"

import {
  changeSlugRequestSchema,
  createOrganizationRequestSchema,
  emailDomainSchema,
  slugAvailabilitySchema,
  updateOrganizationSettingsRequestSchema,
} from "./organizations.ts"

describe("createOrganizationRequestSchema", () => {
  it("accepts a name and a legal slug, with an optional lower-cased domain", () => {
    expect(createOrganizationRequestSchema.parse({ name: " Acme ", slug: "acme", domain: " ACME.com " })).toEqual({
      name: "Acme",
      slug: "acme",
      domain: "acme.com",
    })
  })

  it("rejects a reserved or malformed slug and a non-domain", () => {
    expect(createOrganizationRequestSchema.safeParse({ name: "Acme", slug: "api" }).success).toBe(false)
    expect(createOrganizationRequestSchema.safeParse({ name: "Acme", slug: "Acme" }).success).toBe(false)
    expect(emailDomainSchema.safeParse("not a domain").success).toBe(false)
    expect(emailDomainSchema.safeParse("acme").success).toBe(false)
    expect(emailDomainSchema.safeParse("mail.acme.co.uk").success).toBe(true)
  })
})

describe("slugAvailabilitySchema", () => {
  it("carries a reason only when unavailable", () => {
    expect(slugAvailabilitySchema.parse({ slug: "acme", available: true, reason: null }).reason).toBeNull()
    expect(slugAvailabilitySchema.safeParse({ slug: "api", available: false, reason: "reserved" }).success).toBe(true)
    expect(slugAvailabilitySchema.safeParse({ slug: "x", available: false, reason: "ugly" }).success).toBe(false)
  })
})

describe("organization settings", () => {
  it("refuses an update that changes nothing, and trims a new name", () => {
    expect(updateOrganizationSettingsRequestSchema.safeParse({}).success).toBe(false)
    expect(updateOrganizationSettingsRequestSchema.parse({ name: "  Acme Corp " })).toEqual({ name: "Acme Corp" })
    expect(updateOrganizationSettingsRequestSchema.safeParse({ agentVisibility: "EVERYONE" }).success).toBe(false)
  })

  it("holds a new slug to the one slug rule", () => {
    expect(changeSlugRequestSchema.safeParse({ slug: "acme-corp" }).success).toBe(true)
    expect(changeSlugRequestSchema.safeParse({ slug: "api" }).success).toBe(false)
    expect(changeSlugRequestSchema.safeParse({ slug: "Acme" }).success).toBe(false)
  })
})
