import { describe, expect, it } from "vitest"

import { tenantLookupSchema } from "./tenancy.ts"

describe("tenantLookupSchema", () => {
  it("accepts each outcome a subdomain can be told", () => {
    expect(tenantLookupSchema.parse({ status: "active", slug: "acme" })).toEqual({
      status: "active",
      slug: "acme",
    })
    expect(tenantLookupSchema.parse({ status: "suspended", slug: "acme" }).status).toBe("suspended")
    expect(
      tenantLookupSchema.parse({ status: "moved", slug: "acme", currentSlug: "acme-corp" }),
    ).toEqual({ status: "moved", slug: "acme", currentSlug: "acme-corp" })
  })

  it("requires the destination of a move", () => {
    expect(tenantLookupSchema.safeParse({ status: "moved", slug: "acme" }).success).toBe(false)
  })

  it("never carries a slug that could not be a tenant", () => {
    expect(tenantLookupSchema.safeParse({ status: "active", slug: "api" }).success).toBe(false)
    expect(tenantLookupSchema.safeParse({ status: "active", slug: "Acme" }).success).toBe(false)
  })
})
