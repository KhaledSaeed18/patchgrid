import { PROBLEM_TYPE_SLUGS } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { PROBLEM_TYPES, findProblemType } from "./problems"

describe("problem type pages", () => {
  it("covers every type the API can emit", () => {
    // The Record in problems.ts already makes a missing entry a typecheck error.
    // This catches the version that typechecks and is still useless: an entry
    // present but empty.
    expect(PROBLEM_TYPES).toHaveLength(PROBLEM_TYPE_SLUGS.length)
    for (const problem of PROBLEM_TYPES) {
      expect(problem.title, problem.slug).toBeTruthy()
      expect(problem.detail.length, problem.slug).toBeGreaterThan(30)
      expect(problem.resolution.length, problem.slug).toBeGreaterThan(20)
    }
  })

  it("is addressable by the slug the API puts in the type URI", () => {
    for (const slug of PROBLEM_TYPE_SLUGS) {
      expect(findProblemType(slug), slug).toBeDefined()
    }
    expect(findProblemType("no-such-problem")).toBeUndefined()
  })
})
