import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common"
import {
  changePasswordRequestSchema,
  type LoginResponse,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  resendVerificationRequestSchema,
  signupRequestSchema,
  verifyEmailRequestSchema,
} from "@patchgrid/contracts"
import { Throttle } from "@nestjs/throttler"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"

import { Public, TenantOptional } from "../../common/decorators/route-markers"
import { ActorService } from "../actor"
import { clientOf } from "../auth.controller"
import { CookieService } from "../cookies"
import { IdentityService } from "./identity.service"

class SignupDto extends createZodDto(signupRequestSchema) {}
class VerifyEmailDto extends createZodDto(verifyEmailRequestSchema) {}
class ResendVerificationDto extends createZodDto(resendVerificationRequestSchema) {}
class PasswordResetDto extends createZodDto(passwordResetRequestSchema) {}
class PasswordResetConfirmDto extends createZodDto(passwordResetConfirmSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordRequestSchema) {}

/**
 * The anonymous identity endpoints (ADR-0031). The four `202`s say nothing
 * about whether the address exists; the inbox does. Throttled per IP and per
 * email hash with pipeline step 3.
 */
@Controller("auth")
// Per address here; per email hash through the `email` throttler, for every route that names one.
@Throttle({ ip: { limit: 10, ttl: 60_000 } })
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  @Post("signup")
  @Public()
  @HttpCode(202)
  async signup(@Body() body: SignupDto): Promise<void> {
    await this.identity.signup(body.email, body.password, body.name)
  }

  /** Completes signup and starts the session; the response is login's. */
  @Post("verify-email")
  @Public()
  @HttpCode(200)
  async verifyEmail(
    @Body() body: VerifyEmailDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.identity.verifyEmail(body.token, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }

  @Post("resend-verification")
  @Public()
  @HttpCode(202)
  async resendVerification(@Body() body: ResendVerificationDto): Promise<void> {
    await this.identity.resendVerification(body.email)
  }

  @Post("password-reset")
  @Public()
  @HttpCode(202)
  async requestPasswordReset(@Body() body: PasswordResetDto): Promise<void> {
    await this.identity.requestPasswordReset(body.email)
  }

  @Post("password-reset/confirm")
  @Public()
  @HttpCode(204)
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto): Promise<void> {
    await this.identity.confirmPasswordReset(body.token, body.password)
  }

  /** Ends every session, this one included; the client logs in again. */
  @Post("password")
  @TenantOptional()
  @HttpCode(204)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const identity = this.actors.requireIdentity()
    const clear = await this.identity.changePassword(identity.userId, body.currentPassword, body.newPassword)
    this.cookies.clear(response, clear)
  }
}
