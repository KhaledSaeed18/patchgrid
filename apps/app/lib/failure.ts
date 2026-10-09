import { ApiError } from "./api/errors"

/**
 * An API refusal, in a sentence for a toast or an alert. The API's own
 * `detail` already says why in plain words; this covers the types that need
 * the workspace's vocabulary, and falls back when there is no detail at all.
 */
export function failureMessage(error: Error, fallback: string): string {
  if (error instanceof ApiError && error.type === "plan-limit-reached")
    return "Every agent seat on this plan is in use."
  if (error instanceof ApiError && error.type === "not-permitted")
    return "Your role can't make that change."
  if (error instanceof ApiError && error.problem?.detail !== undefined)
    return error.problem.detail
  return fallback
}
