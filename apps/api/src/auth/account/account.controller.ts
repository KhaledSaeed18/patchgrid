import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common"
import { eraseAccountRequestSchema, erasureConfirmSchema, erasureLinkRequestSchema } from "@patchgrid/contracts"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"
import { createZodDto } from "nestjs-zod"

import { Public, TenantOptional } from "../../common/decorators/route-markers"
import { ActorService } from "../actor"
import { CookieService } from "../cookies"
import { AccountErasureService } from "./account-erasure.service"

class EraseAccountDto extends createZodDto(eraseAccountRequestSchema) {}
class ErasureLinkRequestDto extends createZodDto(erasureLinkRequestSchema) {}
class ErasureConfirmDto extends createZodDto(erasureConfirmSchema) {}

/** The account itself, from the picker's tenant-less surface. */
@Controller("auth/account")
export class AccountController {
  constructor(
    private readonly erasure: AccountErasureService,
    private readonly actors: ActorService,
    private readonly cookies: CookieService,
  ) {}

  /** Erases the account (ADR-0044) and clears every cookie it had. */
  @Post("erase")
  @TenantOptional()
  @HttpCode(204)
  async erase(@Body() body: EraseAccountDto, @Res({ passthrough: true }) response: Response): Promise<void> {
    const clear = await this.erasure.erase(this.actors.requireIdentity().userId, body.password)
    this.cookies.clear(response, clear)
  }

  /**
   * An erasure link to the inbox, for an account with no password to give
   * (ADR-0044 erratum). `202` whether or not the address has an account;
   * throttled as the other anonymous identity routes are.
   */
  @Post("erase/link")
  @Public()
  @HttpCode(202)
  @Throttle({ ip: { limit: 10, ttl: 60_000 } })
  async requestLink(@Body() body: ErasureLinkRequestDto): Promise<void> {
    await this.erasure.requestLink(body.email)
  }

  /** The link spent: the account it names is erased, and whatever cookies this browser holds go. */
  @Post("erase/confirm")
  @Public()
  @HttpCode(204)
  @Throttle({ ip: { limit: 10, ttl: 60_000 } })
  async confirmLink(@Body() body: ErasureConfirmDto, @Res({ passthrough: true }) response: Response): Promise<void> {
    this.cookies.clear(response, await this.erasure.confirmLink(body.token))
  }
}
