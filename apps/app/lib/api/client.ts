import type { z } from "zod"

import { appOrigin, ROOT_DOMAIN } from "@/lib/config"
import { parseHost } from "@/lib/host"

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
  if (response.status !== 401) return readResult(response, call.schema)

  const slug = currentSlug()
  if (slug !== null && (await refresh(slug))) {
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
    return (await fetch(url, { ...init, credentials: "include" })).ok
  } catch {
    return false
  }
}

export function currentSlug(): string | null {
  const host = parseHost(window.location.host, ROOT_DOMAIN)
  return host.kind === "tenant" ? host.slug : null
}

export function toLogin(): void {
  window.location.assign(
    `${appOrigin()}/login?next=${encodeURIComponent(window.location.href)}`
  )
}
