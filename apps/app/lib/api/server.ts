import "server-only"

import {
  accessCookieName,
  type IdentityResponse,
  identityResponseSchema,
  IDENTITY_COOKIE,
  TENANT_HEADER,
} from "@patchgrid/contracts"
import { cookies, headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import type { z } from "zod"

import { PATH_HEADER, REFRESH_PATH, SLUG_HEADER } from "@/lib/routing"

import { buildRequest, type Call, readResult, type Result } from "./request"

/**
 * `apiFetch` for server components (ADR-0007, ADR-0035). Forwards exactly two
 * cookies — this workspace's access token and the identity — never another
 * workspace's, and never a refresh token, which the Next server does not hold.
 * With no `Origin` on a server-to-server call, it names the workspace in
 * `X-Patchgrid-Tenant`, which the API checks against the token (ADR-0024).
 *
 * It never refreshes. A 401 sends the browser through `/session/refresh` (in
 * a workspace) or to login (on `app.`), back to the page being rendered. A
 * 403 or 404 renders the not-found page: a page whose data the member may not
 * read does not exist for them (RBAC.md §11).
 */
export async function serverApi<S extends z.ZodType | null>(
  path: string,
  call: Call<S>
): Promise<Result<S>> {
  const [incoming, jar] = await Promise.all([headers(), cookies()])
  const slug = incoming.get(SLUG_HEADER)
  const page = incoming.get(PATH_HEADER) ?? "/"

  const forwarded = [
    IDENTITY_COOKIE,
    ...(slug === null ? [] : [accessCookieName(slug)]),
  ]
    .map((name) => {
      const value = jar.get(name)?.value
      return value === undefined ? null : `${name}=${value}`
    })
    .filter((c) => c !== null)

  const outgoing = new Headers()
  if (forwarded.length > 0) outgoing.set("Cookie", forwarded.join("; "))
  if (slug !== null) outgoing.set(TENANT_HEADER, slug)

  const [url, init] = buildRequest(path, call, outgoing)
  const response = await fetch(url, { ...init, cache: "no-store" })
  if (response.status === 401) {
    redirect(
      slug === null
        ? `/login?next=${encodeURIComponent(page)}`
        : `${REFRESH_PATH}?next=${encodeURIComponent(page)}`
    )
  }
  if (response.status === 403 || response.status === 404) notFound()
  return readResult(response, call.schema)
}

/**
 * Who is signed in on `app.`, or `null` — for pages that serve signed-out
 * visitors too, where a 401 is an answer rather than a reason to redirect.
 */
export async function serverIdentity(): Promise<IdentityResponse | null> {
  const jar = await cookies()
  const identity = jar.get(IDENTITY_COOKIE)?.value
  if (identity === undefined) return null
  const [url, init] = buildRequest(
    "/auth/identity",
    { schema: identityResponseSchema },
    new Headers({ Cookie: `${IDENTITY_COOKIE}=${identity}` })
  )
  const response = await fetch(url, { ...init, cache: "no-store" })
  if (response.status === 401) return null
  return readResult(response, identityResponseSchema)
}
