import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common"
import { eraseAccountRequestSchema } from "@patchgrid/contracts"
import type { Response } from "express"
import { createZodDto } from "nestjs-zod"

import { TenantOptional } from "../../common/decorators/route-markers"
import { ActorService } from "../actor"
import { CookieService } from "../cookies"
import { AccountErasureService } from "./account-erasure.service"

class EraseAccountDto extends createZodDto(eraseAccountRequestSchema) {}

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
}
