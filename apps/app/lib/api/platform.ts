import type { z } from "zod"

import { buildRequest, type Call, readResult, type Result } from "./request"

/**
 * `apiFetch` for the back-office (ADR-0040): straight to the API's platform
 * routes with credentials, so the browser's `pg_pa` — scoped to those routes,
 * and never seen by the Next server — goes with it. A 401 is the end of the
 * hour or a sign-out elsewhere: back to the admin login, then here again.
 * There is no refresh; an operator signs in again, factor included.
 */
export async function platformApi<S extends z.ZodType | null>(
  path: string,
  call: Call<S>
): Promise<Result<S>> {
  const [url, init] = buildRequest(`/platform${path}`, call, new Headers())
  const response = await fetch(url, { ...init, credentials: "include" })
  if (response.status === 401 && call.anonymous !== true) {
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
    )
    return new Promise<never>(() => undefined)
  }
  return readResult(response, call.schema)
}
