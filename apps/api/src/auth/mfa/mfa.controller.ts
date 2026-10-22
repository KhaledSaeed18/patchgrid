import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import {
  type FactorAdded,
  type LoginResponse,
  MFA_CHALLENGE_COOKIE,
  mfaConfirmRequestSchema,
  mfaDisableRequestSchema,
  mfaEnrolRequestSchema,
  type MfaEnrolment,
  mfaLoginRequestSchema,
  mfaRegenerateRecoveryRequestSchema,
  type MfaStatus,
  type PasskeyRequestCeremony,
  type RecoveryCodes,
  stepUpRequestSchema,
  type StepUpResponse,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"

import { Public, TenantOptional } from "../../common/decorators/route-markers"
import { ActorService } from "../actor"
import { clientOf } from "../auth.controller"
import { CookieService, readCookie } from "../cookies"
import { PasskeyService } from "../passkeys/passkey.service"
import { MemberMfaService } from "./member-mfa.service"
import { StepUpService } from "./step-up.service"

class MfaLoginDto extends createZodDto(mfaLoginRequestSchema) {}
class ConfirmDto extends createZodDto(mfaConfirmRequestSchema) {}
class DisableDto extends createZodDto(mfaDisableRequestSchema) {}
class EnrolDto extends createZodDto(mfaEnrolRequestSchema) {}
class RegenerateDto extends createZodDto(mfaRegenerateRecoveryRequestSchema) {}
class StepUpDto extends createZodDto(stepUpRequestSchema) {}

/**
 * A member's second factor and step-up (ADR-0045). Tenant-less like the rest
 * of `/auth`: the second step of login is authenticated by the challenge
 * cookie, self-service by `pg_id`, and step-up names its workspace the way
 * `POST /auth/sessions` does — then re-reads the membership before minting.
 */
@Controller("auth")
// Tight per address: codes are what an attacker with a password guesses next.
@Throttle({ ip: { limit: 20, ttl: 60_000 } })
export class MfaController {
  constructor(
    private readonly factors: MemberMfaService,
    private readonly stepUp: StepUpService,
    private readonly passkeys: PasskeyService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  /** A passkey challenge for the second step, authenticated by the challenge cookie the password step set (ADR-0053). */
  @Post("mfa/passkey/options")
  @Public()
  @HttpCode(200)
  secondStepOptions(@Req() request: Request): Promise<PasskeyRequestCeremony> {
    return this.passkeys.secondStepOptions(readCookie(request, MFA_CHALLENGE_COOKIE))
  }

  /** The second step of login. Same `400` for a wrong code and a wrong recovery code. */
  @Post("mfa")
  @Public()
  @HttpCode(200)
  async completeLogin(@Body() body: MfaLoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<LoginResponse> {
    const result = await this.factors.completeLogin(readCookie(request, MFA_CHALLENGE_COOKIE), body, clientOf(request))
    this.cookies.clear(response, result.clear)
    this.cookies.set(response, result.cookies)
    return result.response
  }

  @Get("mfa")
  @TenantOptional()
  status(): Promise<MfaStatus> {
    return this.factors.status(this.actors.requireIdentity().userId)
  }

  /** Proved by a factor, or the password when there is none: a `pg_id` alone must not be able to set the factor (THREAT-MODEL §7, ADR-0053). */
  @Post("mfa/enrol")
  @TenantOptional()
  @HttpCode(200)
  enrol(@Body() body: EnrolDto): Promise<MfaEnrolment> {
    return this.factors.enrol(this.actors.requireIdentity().userId, body)
  }

  @Post("mfa/confirm")
  @TenantOptional()
  @HttpCode(200)
  confirm(@Body() body: ConfirmDto): Promise<FactorAdded> {
    return this.factors.confirm(this.actors.requireIdentity().userId, body.code)
  }

  @Post("mfa/recovery-codes")
  @TenantOptional()
  @HttpCode(200)
  regenerate(@Body() body: RegenerateDto): Promise<RecoveryCodes> {
    return this.factors.regenerateRecoveryCodes(this.actors.requireIdentity().userId, body)
  }

  @Post("mfa/disable")
  @TenantOptional()
  @HttpCode(204)
  async disable(@Body() body: DisableDto): Promise<void> {
    await this.factors.disable(this.actors.requireIdentity().userId, body)
  }

  /** Re-proves the holder and re-issues the named workspace's pair with the proof on it. */
  @Post("step-up")
  @TenantOptional()
  @HttpCode(200)
  async prove(@Body() body: StepUpDto, @Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<StepUpResponse> {
    const result = await this.stepUp.prove(this.actors.requireIdentity().userId, body, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }
}
