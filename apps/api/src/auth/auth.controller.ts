import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common"
import {
  type LoginResponse,
  loginRequestSchema,
  logoutRequestSchema,
  openSessionRequestSchema,
  refreshRequestSchema,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { isIP } from "node:net"

import { Public, TenantOptional } from "../common/decorators/route-markers"
import { ActorService } from "./actor"
import { CookieService, readCookie } from "./cookies"
import { type ClientInfo, SessionService } from "./sessions/session.service"
import { IDENTITY_COOKIE, refreshCookieName } from "./tokens/access-token"

class LoginDto extends createZodDto(loginRequestSchema) {}
class OpenSessionDto extends createZodDto(openSessionRequestSchema) {}
class RefreshDto extends createZodDto(refreshRequestSchema) {}
class LogoutDto extends createZodDto(logoutRequestSchema) {}

/**
 * Sessions. Every route here is tenant-less — the auth routes are the one
 * documented exception to "the tenant is never a request parameter"
 * (ENGINEERING.md §API conventions): `slug` names which cookie to mint or
 * rotate, and the service re-reads the membership before honouring it.
 *
 * Cookies are set and cleared here, because they are HTTP; the service
 * returns descriptions of them.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  /** Uniform 401 whether or not the address exists (ADR-0031). */
  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.sessions.login(body.email, body.password, body.slug, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }

  /** The org switcher: mint a pair for a workspace the `pg_id` holder belongs to. */
  @Post("sessions")
  @TenantOptional()
  @HttpCode(200)
  async open(
    @Body() body: OpenSessionDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ session: { slug: string } }> {
    const identity = this.actors.requireIdentity()
    const cookies = await this.sessions.open(identity.userId, body.slug, clientOf(request))
    this.cookies.set(response, cookies)
    return { session: { slug: body.slug } }
  }

  /** Rotation with reuse detection (ADR-0004). Authenticated by the refresh cookie itself. */
  @Post("refresh")
  @Public()
  @HttpCode(204)
  async refresh(
    @Body() body: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const presented = readCookie(request, refreshCookieName(body.slug))
    const cookies = await this.sessions.refresh(body.slug, presented, clientOf(request))
    this.cookies.set(response, cookies)
  }

  /** One workspace, or everywhere. Idempotent. */
  @Post("logout")
  @Public()
  @HttpCode(204)
  async logout(
    @Body() body: LogoutDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const clear = await this.sessions.logout({
      slug: body.slug,
      everywhere: body.everywhere,
      refreshSecret: body.slug === undefined ? undefined : readCookie(request, refreshCookieName(body.slug)),
      identitySecret: readCookie(request, IDENTITY_COOKIE),
    })
    this.cookies.clear(response, clear)
  }
}

export function clientOf(request: Request): ClientInfo {
  const userAgent = request.headers["user-agent"]
  const ip = request.ip
  return {
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 255) : null,
    // The column is `inet`; anything else would fail the insert.
    ip: typeof ip === "string" && isIP(ip) !== 0 ? ip : null,
  }
}
