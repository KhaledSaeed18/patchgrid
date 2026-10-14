import { describe, expect, it } from "vitest"

import { assetListQuerySchema, createAssetRequestSchema, updateAssetRequestSchema } from "./assets.ts"

describe("an asset request", () => {
  it("creates in stock unless told otherwise, and takes calendar days", () => {
    const parsed = createAssetRequestSchema.parse({ name: " ThinkPad T14 ", type: "LAPTOP", purchaseDate: "2025-03-01" })
    expect(parsed).toMatchObject({ name: "ThinkPad T14", status: "IN_STOCK", purchaseDate: "2025-03-01" })
  })

  it("refuses an instant where a day belongs, an unknown type and an unknown field", () => {
    expect(createAssetRequestSchema.safeParse({ name: "x", type: "LAPTOP", purchaseDate: "2025-03-01T00:00:00Z" }).success).toBe(false)
    expect(createAssetRequestSchema.safeParse({ name: "x", type: "TOASTER" }).success).toBe(false)
    expect(createAssetRequestSchema.safeParse({ name: "x", type: "LAPTOP", orgId: "x" }).success).toBe(false)
  })

  it("updates at least one field, and null clears an optional one", () => {
    expect(updateAssetRequestSchema.safeParse({}).success).toBe(false)
    expect(updateAssetRequestSchema.parse({ ownerMembershipId: null })).toEqual({ ownerMembershipId: null })
  })

  it("lists with a bounded search", () => {
    expect(assetListQuerySchema.parse({ q: "dell" })).toMatchObject({ q: "dell", limit: 25 })
    expect(assetListQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false)
  })
})
