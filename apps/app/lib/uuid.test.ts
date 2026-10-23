import { idSchema } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { newUuid } from "./idempotency"

describe("newUuid", () => {
  it("makes UUIDs the API accepts as ids, different every time", () => {
    const a = newUuid()
    expect(idSchema.safeParse(a).success).toBe(true)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(newUuid()).not.toBe(a)
  })
})
