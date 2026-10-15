import { describe, expect, it } from "vitest"

import { ApiError } from "./api/errors"
import { isStepUpRequired, StepUpCancelled } from "./step-up"

const problem = (type: string, status: number) =>
  new ApiError(status, {
    type: `https://patchgrid.xyz/problems/${type}`,
    title: type,
    status,
  })

describe("isStepUpRequired", () => {
  it("is the one 403 the UI answers with a dialog rather than a toast", () => {
    expect(isStepUpRequired(problem("step-up-required", 403))).toBe(true)
    expect(isStepUpRequired(problem("not-permitted", 403))).toBe(false)
    expect(isStepUpRequired(problem("mfa-required", 403))).toBe(false)
    expect(isStepUpRequired(new Error("network"))).toBe(false)
  })

  it("names a cancelled step-up so callers can stay quiet about it", () => {
    expect(new StepUpCancelled()).toBeInstanceOf(Error)
    expect(new StepUpCancelled().name).toBe("StepUpCancelled")
  })
})
