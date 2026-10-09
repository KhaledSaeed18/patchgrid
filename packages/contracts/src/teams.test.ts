import { describe, expect, it } from "vitest"

import { createTeamRequestSchema, updateTeamRequestSchema } from "./teams.ts"

describe("team shapes", () => {
  it("trims a name and refuses an empty one", () => {
    expect(createTeamRequestSchema.parse({ name: "  Network  " }).name).toBe("Network")
    expect(createTeamRequestSchema.safeParse({ name: "   " }).success).toBe(false)
  })

  it("refuses an update that changes nothing", () => {
    expect(updateTeamRequestSchema.safeParse({}).success).toBe(false)
    expect(updateTeamRequestSchema.parse({ isActive: false })).toEqual({ isActive: false })
    expect(updateTeamRequestSchema.parse({ description: null })).toEqual({ description: null })
  })
})
