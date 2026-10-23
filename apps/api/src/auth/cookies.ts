import { Injectable } from "@nestjs/common"
import { parseCookie } from "cookie"
import type { Request, Response } from "express"

import { InjectConfig, type AppConfig } from "../config/app-config"
import {
  MAX_TENANT_PAIRS,
  MFA_CHALLENGE_COOKIE,
  RECENT_WORKSPACES_COOKIE,
  RECENT_WORKSPACES_COOKIE_PATH,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  SSO_FLOW_COOKIE,
  SSO_FLOW_COOKIE_PATH,
} from "@patchgrid/contracts"

import {
  ACCESS_COOKIE_PREFIX,
  accessCookieName,
  IDENTITY_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_PREFIX,
  refreshCookieName,
} from "./tokens/access-token"

export type CookieSpec = {
  name: string
  value: string
  path: string
  maxAgeSeconds: number
}

export type CookieName = Pick<CookieSpec, "name" | "path">

/**
 * Every session cookie, with the attributes ADR-0024 §2 fixes: shared across
 * `app.`, `<slug>.` and `api.` through `Domain`, `httpOnly`, `SameSite=Lax`
 * (defence in depth only — subdomains are same-site), `Secure` outside
 * development, and the refresh cookie path-scoped to the auth routes so no
 * other request ever carries it.
 */
@Injectable()
export class CookieService {
  constructor(@InjectConfig() private readonly config: AppConfig) {}

  access(slug: string, token: string): CookieSpec {
    return {
      name: accessCookieName(slug),
      value: token,
      path: "/",
      maxAgeSeconds: this.config.ACCESS_TOKEN_TTL_SECONDS,
    }
  }

  refresh(slug: string, secret: string): CookieSpec {
    return {
      name: refreshCookieName(slug),
      value: secret,
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    }
  }

  identity(secret: string): CookieSpec {
    return {
      name: IDENTITY_COOKIE,
      value: secret,
      path: "/",
      maxAgeSeconds: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    }
  }

  /** Between the password and the factor (ADR-0045): auth routes only, five minutes. */
  mfaChallenge(token: string, ttlSeconds: number): CookieSpec {
    return { name: MFA_CHALLENGE_COOKIE, value: token, path: REFRESH_COOKIE_PATH, maxAgeSeconds: ttlSeconds }
  }

  /** One SSO round trip's `state` (ADR-0054): the SSO routes only, as long as the flow lives. */
  ssoFlow(state: string, ttlSeconds: number): CookieSpec {
    return { name: SSO_FLOW_COOKIE, value: state, path: SSO_FLOW_COOKIE_PATH, maxAgeSeconds: ttlSeconds }
  }

  /** The names a workspace's pair is cleared under. */
  pairOf(slug: string): CookieName[] {
    return [
      { name: accessCookieName(slug), path: "/" },
      { name: refreshCookieName(slug), path: REFRESH_COOKIE_PATH },
    ]
  }

  /**
   * Sets the cookies, and when a workspace pair is among them, moves that
   * workspace to the front of the browser's recent list and expires the
   * pairs past the budget (ADR-0024 §2): the picker re-mints on demand.
   */
  set(response: Response, cookies: readonly CookieSpec[]): void {
    for (const cookie of cookies) {
      response.cookie(cookie.name, cookie.value, {
        ...this.attributes(cookie.path),
        maxAge: cookie.maxAgeSeconds * 1000,
      })
    }
    const minted = cookies.flatMap((cookie) => slugOf(cookie.name, ACCESS_COOKIE_PREFIX))
    if (minted.length === 0) return
    const order = unique([...minted, ...this.recent(response)])
    const dropped = order.slice(MAX_TENANT_PAIRS)
    for (const slug of dropped) for (const cookie of this.pairOf(slug)) response.clearCookie(cookie.name, this.attributes(cookie.path))
    this.remember(response, order.slice(0, MAX_TENANT_PAIRS))
  }

  clear(response: Response, cookies: readonly CookieName[]): void {
    for (const cookie of cookies) {
      response.clearCookie(cookie.name, this.attributes(cookie.path))
    }
    const gone = new Set(cookies.flatMap((cookie) => slugOf(cookie.name, ACCESS_COOKIE_PREFIX)))
    if (gone.size === 0) return
    this.remember(response, this.recent(response).filter((slug) => !gone.has(slug)))
  }

  /**
   * The browser's workspaces, most recent first: the list this response has
   * already written, or the request's — followed by any pair the request
   * carries that the list does not name (minted before it existed), oldest.
   */
  private recent(response: Response): string[] {
    const written = this.pending.get(response)
    if (written !== undefined) return written
    const request = response.req
    const listed = parseRecent(readCookie(request, RECENT_WORKSPACES_COOKIE))
    const held = Object.keys(parseCookie(request.headers.cookie ?? "")).flatMap((name) => [
      ...slugOf(name, ACCESS_COOKIE_PREFIX),
      ...slugOf(name, REFRESH_COOKIE_PREFIX),
    ])
    return unique([...listed, ...held])
  }

  private remember(response: Response, slugs: string[]): void {
    this.pending.set(response, slugs)
    response.cookie(RECENT_WORKSPACES_COOKIE, slugs.join("."), {
      ...this.attributes(RECENT_WORKSPACES_COOKIE_PATH),
      maxAge: this.config.REFRESH_TOKEN_TTL_DAYS * 86_400 * 1000,
    })
  }

  /** What this response has written to the list so far, so a set and a clear in one response compose. */
  private readonly pending = new WeakMap<Response, string[]>()

  private attributes(path: string) {
    return {
      domain: this.config.COOKIE_DOMAIN,
      path,
      httpOnly: true,
      sameSite: "lax" as const,
      secure: this.config.isProduction,
    }
  }
}

/** The slug a pair cookie is named for, if `name` is one and the slug could be. */
function slugOf(name: string, prefix: string): string[] {
  if (!name.startsWith(prefix)) return []
  const slug = name.slice(prefix.length)
  return isSlugShaped(slug) ? [slug] : []
}

function isSlugShaped(slug: string): boolean {
  return slug.length >= SLUG_MIN_LENGTH && slug.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(slug)
}

/** The list cookie, read defensively: it is the browser's to send, so anything not slug-shaped is dropped. */
function parseRecent(value: string | undefined): string[] {
  if (value === undefined) return []
  return unique(value.split(".").filter(isSlugShaped)).slice(0, MAX_TENANT_PAIRS * 4)
}

function unique(slugs: readonly string[]): string[] {
  return [...new Set(slugs)]
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  const value = parseCookie(header)[name]
  return value === undefined || value === "" ? undefined : value
}
