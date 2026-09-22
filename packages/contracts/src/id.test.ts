import { describe, expect, it } from "vitest"

import { idSchema, isUuidV7, uuidV7Schema } from "./id.ts"

const V7 = "0195f0a0-1b2c-7d3e-8f01-234567890abc"
const V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

describe("idSchema", () => {
  it("accepts any UUID version on the wire", () => {
    // Deliberately permissive: an id we did not issue should 404, not 400.
    expect(idSchema.safeParse(V7).success).toBe(true)
    expect(idSchema.safeParse(V4).success).toBe(true)
  })

  it.each(["", "not-a-uuid", "0195f0a0-1b2c-7d3e-8f01", "0195f0a01b2c7d3e8f01234567890abc"])(
    "rejects %s",
    (value) => {
      expect(idSchema.safeParse(value).success).toBe(false)
    },
  )
})

describe("uuidV7Schema", () => {
  it("is strict, for asserting our own generation", () => {
    expect(uuidV7Schema.safeParse(V7).success).toBe(true)
    expect(uuidV7Schema.safeParse(V4).success).toBe(false)
    expect(isUuidV7(V7)).toBe(true)
    expect(isUuidV7(V4)).toBe(false)
  })
})
