import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import {
  idSchema,
  memberFactorProofSchema,
  type Passkey,
  type PasskeyCreationCeremony,
  passkeyLoginRequestSchema,
  type PasskeyRegistered,
  passkeyRegisterRequestSchema,
  passkeyRegistrationOptionsRequestSchema,
  passkeyRenameRequestSchema,
  type PasskeyRequestCeremony,
  type SignedInResponse,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { Public, TenantOptional } from "../../common/decorators/route-markers"
import { ActorService } from "../actor"
import { clientOf } from "../auth.controller"
import { CookieService } from "../cookies"
import { PasskeyService } from "./passkey.service"

class PasskeyParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class PasskeyRegistrationOptionsDto extends createZodDto(passkeyRegistrationOptionsRequestSchema) {}
class PasskeyRegisterDto extends createZodDto(passkeyRegisterRequestSchema) {}
class PasskeyRenameDto extends createZodDto(passkeyRenameRequestSchema) {}
class PasskeyRemoveDto extends createZodDto(memberFactorProofSchema) {}
class PasskeyLoginDto extends createZodDto(passkeyLoginRequestSchema) {}

/**
 * Passkeys (ADR-0053). Tenant-less like the rest of `/auth`: self-service is
 * authenticated by `pg_id`, the passwordless login by nothing but the
 * assertion. Each ceremony is two calls — options, then the browser's answer
 * to the challenge they carry.
 */
@Controller("auth/passkeys")
// Tight per address, like every route an attacker would guess against.
@Throttle({ ip: { limit: 20, ttl: 60_000 } })
export class PasskeyController {
  constructor(
    private readonly passkeys: PasskeyService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  @Get()
  @TenantOptional()
  list(): Promise<Passkey[]> {
    return this.passkeys.list(this.actors.requireIdentity().userId)
  }

  /** Proved by a factor, or the password when there is none: a `pg_id` alone cannot add a passkey. */
  @Post("registration/options")
  @TenantOptional()
  @HttpCode(200)
  registrationOptions(@Body() body: PasskeyRegistrationOptionsDto): Promise<PasskeyCreationCeremony> {
    return this.passkeys.registrationOptions(this.actors.requireIdentity().userId, body)
  }

  @Post()
  @TenantOptional()
  register(@Body() body: PasskeyRegisterDto): Promise<PasskeyRegistered> {
    return this.passkeys.register(this.actors.requireIdentity().userId, body)
  }

  @Patch(":id")
  @TenantOptional()
  rename(@Param() params: PasskeyParamsDto, @Body() body: PasskeyRenameDto): Promise<Passkey> {
    return this.passkeys.rename(this.actors.requireIdentity().userId, params.id, body.label)
  }

  /** A `POST`, like turning the authenticator app off: removal carries a proof in its body. */
  @Post(":id/remove")
  @TenantOptional()
  @HttpCode(204)
  async remove(@Param() params: PasskeyParamsDto, @Body() body: PasskeyRemoveDto): Promise<void> {
    await this.passkeys.remove(this.actors.requireIdentity().userId, params.id, body)
  }

  /** A challenge for a `pg_id` holder to prove themselves with: step-up, removal, a new factor. */
  @Post("proof/options")
  @TenantOptional()
  @HttpCode(200)
  proofOptions(): Promise<PasskeyRequestCeremony> {
    return this.passkeys.proofOptions(this.actors.requireIdentity().userId)
  }

  @Post("login/options")
  @Public()
  @HttpCode(200)
  loginOptions(): Promise<PasskeyRequestCeremony> {
    return this.passkeys.loginOptions()
  }

  /** One `401` for every refusal, as the password login. */
  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: PasskeyLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedInResponse> {
    const result = await this.passkeys.login(body, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }
}
