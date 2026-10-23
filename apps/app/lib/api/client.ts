import type { z } from "zod"

import { adminOrigin, appOrigin, ROOT_DOMAIN } from "@/lib/config"
import { parseHost } from "@/lib/host"
import { ssoStartUrl } from "@/lib/sso"

import { buildRequest, type Call, readResult, type Result } from "./request"

/**
 * `apiFetch` for the browser (ADR-0007, ADR-0035): straight to the API with
 * credentials, so the browser's own cookies — including the path-scoped
 * refresh token — go with it. On a 401 it refreshes once and retries once;
 * concurrent 401s share one refresh, because two rotations of one token in
 * parallel look exactly like theft to the API's reuse detection.
 */
export async function clientApi<S extends z.ZodType | null>(
  path: string,
  call: Call<S>
): Promise<Result<S>> {
  const response = await send(path, call)
  if (response.status !== 401 || call.anonymous === true)
    return readResult(response, call.schema)

  const slug = currentSlug()
  // A support session has nothing to refresh from: its end is the end.
  if (slug !== null && !supportOperator && (await refresh(slug))) {
    const retried = await send(path, call)
    if (retried.status !== 401) return readResult(retried, call.schema)
  }
  toLogin()
  // Navigation is under way; nothing useful to return to the caller.
  return new Promise<never>(() => undefined)
}

function send(path: string, call: Call<z.ZodType | null>): Promise<Response> {
  const [url, init] = buildRequest(path, call, new Headers())
  return fetch(url, { ...init, credentials: "include" })
}

let inFlight: Promise<boolean> | null = null

/** One refresh at a time, shared by everyone who hit a 401 meanwhile. */
export function refresh(slug: string): Promise<boolean> {
  inFlight ??= attemptRefresh(slug).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function attemptRefresh(slug: string): Promise<boolean> {
  try {
    const [url, init] = buildRequest(
      "/auth/refresh",
      { method: "POST", body: { slug }, schema: null },
      new Headers()
    )
    const response = await fetch(url, { ...init, credentials: "include" })
    // The workspace now requires its identity provider (ADR-0054): there, not the login page.
    if (response.status === 403 && (await problemType(response)) === "sso-required") {
      window.location.assign(ssoStartUrl({ slug }, { next: window.location.pathname + window.location.search }))
      return new Promise<never>(() => undefined)
    }
    return response.ok
  } catch {
    return false
  }
}

async function problemType(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    const type = typeof body === "object" && body !== null && "type" in body ? body.type : null
    return typeof type === "string" ? (type.split("/").at(-1) ?? null) : null
  } catch {
    return null
  }
}

export function currentSlug(): string | null {
  const host = parseHost(window.location.host, ROOT_DOMAIN)
  return host.kind === "tenant" ? host.slug : null
}

let supportOperator = false

/** Set by the workspace shell when this browser is an operator's support session (ADR-0041). */
export function markSupportOperator(value: boolean): void {
  supportOperator = value
}

/**
 * Where a lost session goes. A member signs in again on `app.`; an operator
 * whose support session ended goes back to the back-office it came from —
 * there is no member login for them to land on.
 */
export function toLogin(): void {
  if (supportOperator) {
    window.location.assign(`${adminOrigin()}/orgs`)
    return
  }
  window.location.assign(
    `${appOrigin()}/login?next=${encodeURIComponent(window.location.href)}`
  )
}
