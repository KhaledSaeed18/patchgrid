import { ApiError } from "./api/errors"

/** The API asked for a fresh proof before an irreversible action (ADR-0029). */
export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.type === "step-up-required"
}

/** The person closed the step-up dialog: the action simply did not happen, and nothing to toast. */
export class StepUpCancelled extends Error {
  constructor() {
    super("Step-up cancelled")
    this.name = "StepUpCancelled"
  }
}
