import { describe, expect, it } from "vitest"

import { updateCategoryRequestSchema, updateSlaPolicyRequestSchema } from "./categories.ts"

describe("category and SLA shapes", () => {
  it("refuse an empty category update, and allow moving to the top", () => {
    expect(updateCategoryRequestSchema.safeParse({}).success).toBe(false)
    expect(updateCategoryRequestSchema.parse({ parentId: null })).toEqual({ parentId: null })
  })

  it("keep warnings inside their targets, naming the field", () => {
    const ok = { responseTargetMinutes: 30, resolutionTargetMinutes: 480, responseWarningMinutes: 10, resolutionWarningMinutes: 60 }
    expect(updateSlaPolicyRequestSchema.safeParse(ok).success).toBe(true)
    const bad = updateSlaPolicyRequestSchema.safeParse({ ...ok, responseWarningMinutes: 30 })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(["responseWarningMinutes"])
  })
})
