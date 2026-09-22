import { describe, expect, it } from "vitest"

import {
  PROBLEM_TYPES,
  PROBLEM_TYPE_SLUGS,
  problemDetailsSchema,
  problemStatus,
  problemTypeUrl,
} from "./problems.ts"

describe("problem types", () => {
  it("assigns every type a plausible status", () => {
    for (const slug of PROBLEM_TYPE_SLUGS) {
      const status = problemStatus(slug)
      expect(status, slug).toBeGreaterThanOrEqual(400)
      expect(status, slug).toBeLessThan(600)
    }
  })

  it("reserves 402 for plan limits alone", () => {
    // `ENGINEERING.md`: 402 means a plan limit and nothing else. A second 402
    // would make the UI's upgrade prompt fire on unrelated failures.
    const paymentRequired = PROBLEM_TYPE_SLUGS.filter((s) => PROBLEM_TYPES[s] === 402)
    expect(paymentRequired).toEqual(["plan-limit-reached"])
  })

  it("builds type URIs on the real domain", () => {
    expect(problemTypeUrl("invalid-transition")).toBe(
      "https://patchgrid.xyz/problems/invalid-transition",
    )
  })
})

describe("problemDetailsSchema", () => {
  it("accepts a minimal problem", () => {
    const parsed = problemDetailsSchema.parse({
      type: problemTypeUrl("not-found"),
      title: "Not found",
      status: 404,
    })
    expect(parsed.status).toBe(404)
  })

  it("accepts field errors for form mapping", () => {
    const parsed = problemDetailsSchema.parse({
      type: problemTypeUrl("validation-failed"),
      title: "Validation failed",
      status: 400,
      errors: [{ path: "slug", message: "is reserved", code: "custom" }],
    })
    expect(parsed.errors?.[0]?.path).toBe("slug")
  })

  it("rejects a status outside the HTTP range", () => {
    expect(
      problemDetailsSchema.safeParse({ type: problemTypeUrl("conflict"), title: "x", status: 99 })
        .success,
    ).toBe(false)
  })
})
