import { type ProblemDetails, problemDetailsSchema } from "@patchgrid/contracts"

/**
 * A non-2xx answer from the API, as the Problem Details it carried (ADR-0012).
 * Components switch on `type` (the slug) and map `errors` onto form fields;
 * they never parse status codes or message text.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with ${status}`)
    this.name = "ApiError"
  }

  /** The problem type's slug — `conflict`, `plan-limit-reached`, … — or `null` for a non-problem body. */
  get type(): string | null {
    return this.problem?.type.split("/").at(-1) ?? null
  }

  /** The message for one form field, from a `400`'s `errors`. */
  fieldError(path: string): string | undefined {
    return this.problem?.errors?.find((e) => e.path === path)?.message
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Not JSON; the status is all there is.
  }
  const parsed = problemDetailsSchema.safeParse(body)
  return new ApiError(response.status, parsed.success ? parsed.data : null)
}
