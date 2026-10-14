import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common"
import {
  type MfaEnrolment,
  mfaConfirmRequestSchema,
  mfaVerifyRequestSchema,
  platformLoginRequestSchema,
  type PlatformLoginStep,
  type PlatformMe,
  type RecoveryCodes,
} from "@patchgrid/contracts"
import { Throttle } from "@nestjs/throttler"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"

import { PlatformRoute, Public } from "../../common/decorators/route-markers"
import { originPolicyFrom } from "../../common/http/origin-policy"
import { NotPermittedProblem } from "../../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { ActorService } from "../actor"
import { readCookie } from "../cookies"
import { PlatformAuthService, type SignedIn } from "./platform-auth.service"
import { CHALLENGE_TTL_SECONDS } from "./platform-token.service"
import {
  fromAdminSurface,
  PLATFORM_CHALLENGE_COOKIE,
  PLATFORM_CHALLENGE_PATH,
  PLATFORM_SESSION_COOKIE,
  PLATFORM_SESSION_PATH,
} from "./surface"

class LoginDto extends createZodDto(platformLoginRequestSchema) {}
class VerifyDto extends createZodDto(mfaVerifyRequestSchema) {}
class ConfirmDto extends createZodDto(mfaConfirmRequestSchema) {}

/**
 * `/platform/auth` (ADR-0040). The steps before a session are `@Public` —
 * their credential is the challenge cookie — but only from the `admin.`
 * surface, so no other page can drive an operator's login. Tight limits per
 * address: these are the routes an attacker guesses against.
 */
@Controller("platform/auth")
@Throttle({ ip: { limit: 10, ttl: 60_000 } })
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly actors: ActorService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  @Post("login")
  @Public()
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<PlatformLoginStep> {
    this.requireSurface(request)
    const { step, challenge } = await this.auth.login(body.email, body.password)
    this.setCookie(response, PLATFORM_CHALLENGE_COOKIE, challenge, PLATFORM_CHALLENGE_PATH, CHALLENGE_TTL_SECONDS)
    return step
  }

  @Post("mfa/enrol")
  @Public()
  @HttpCode(200)
  enrol(@Req() request: Request): Promise<MfaEnrolment> {
    this.requireSurface(request)
    return this.auth.enrol(readCookie(request, PLATFORM_CHALLENGE_COOKIE))
  }

  @Post("mfa/confirm")
  @Public()
  @HttpCode(200)
  async confirm(@Body() body: ConfirmDto, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<RecoveryCodes> {
    this.requireSurface(request)
    const result = await this.auth.confirm(readCookie(request, PLATFORM_CHALLENGE_COOKIE), body.code)
    this.startSession(response, result)
    return { recoveryCodes: result.recoveryCodes }
  }

  @Post("mfa")
  @Public()
  @HttpCode(204)
  async verify(@Body() body: VerifyDto, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    this.requireSurface(request)
    this.startSession(response, await this.auth.verify(readCookie(request, PLATFORM_CHALLENGE_COOKIE), body))
  }

  @Get("me")
  @PlatformRoute()
  me(): Promise<PlatformMe> {
    return this.auth.me(this.actors.requirePlatform())
  }

  @Post("logout")
  @PlatformRoute()
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(this.actors.requirePlatform())
    response.clearCookie(PLATFORM_SESSION_COOKIE, this.attributes(PLATFORM_SESSION_PATH))
  }

  private startSession(response: Response, signedIn: SignedIn): void {
    response.clearCookie(PLATFORM_CHALLENGE_COOKIE, this.attributes(PLATFORM_CHALLENGE_PATH))
    const maxAge = signedIn.session.expiresAt - Math.floor(Date.now() / 1000)
    this.setCookie(response, PLATFORM_SESSION_COOKIE, signedIn.session.token, PLATFORM_SESSION_PATH, Math.max(maxAge, 0))
  }

  private requireSurface(request: Request): void {
    if (!fromAdminSurface(request, originPolicyFrom(this.config))) throw new NotPermittedProblem("Operators sign in at the admin surface")
  }

  private setCookie(response: Response, name: string, value: string, path: string, maxAgeSeconds: number): void {
    response.cookie(name, value, { ...this.attributes(path), maxAge: maxAgeSeconds * 1000 })
  }

  private attributes(path: string) {
    return { domain: this.config.COOKIE_DOMAIN, path, httpOnly: true, sameSite: "lax" as const, secure: this.config.isProduction }
  }
}
