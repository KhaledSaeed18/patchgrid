import { Injectable } from "@nestjs/common"
import { parse as parseCookies } from "cookie"
import type { Request, Response } from "express"

import { InjectConfig, type AppConfig } from "../config/app-config"
import {
  accessCookieName,
  IDENTITY_COOKIE,
  REFRESH_COOKIE_PATH,
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

  /** The names a workspace's pair is cleared under. */
  pairOf(slug: string): CookieName[] {
    return [
      { name: accessCookieName(slug), path: "/" },
      { name: refreshCookieName(slug), path: REFRESH_COOKIE_PATH },
    ]
  }

  set(response: Response, cookies: readonly CookieSpec[]): void {
    for (const cookie of cookies) {
      response.cookie(cookie.name, cookie.value, {
        ...this.attributes(cookie.path),
        maxAge: cookie.maxAgeSeconds * 1000,
      })
    }
  }

  clear(response: Response, cookies: readonly CookieName[]): void {
    for (const cookie of cookies) {
      response.clearCookie(cookie.name, this.attributes(cookie.path))
    }
  }

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

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  const value = parseCookies(header)[name]
  return value === undefined || value === "" ? undefined : value
}
