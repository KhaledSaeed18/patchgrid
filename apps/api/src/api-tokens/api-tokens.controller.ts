import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common"
import { type ApiToken, createApiTokenRequestSchema, type CreatedApiToken, idSchema } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { ApiTokensService } from "./api-tokens.service"

class TokenParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class CreateTokenDto extends createZodDto(createApiTokenRequestSchema) {}

/** `/org/api-tokens` — machine access to the workspace (ADR-0021, ADR-0042). */
@Controller("org/api-tokens")
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  @RequirePermission("token:read")
  list(): Promise<ApiToken[]> {
    return this.tokens.list()
  }

  /**
   * Not `@Idempotent`, deliberately (ADR-0042): a replayable answer would be
   * the secret, stored in Redis. A retried create makes a second token, which
   * the list shows and an admin can revoke.
   */
  @Post()
  @RequirePermission("token:create")
  create(@Body() body: CreateTokenDto): Promise<CreatedApiToken> {
    return this.tokens.create(body)
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @RequirePermission("token:revoke")
  revoke(@Param() params: TokenParamsDto): Promise<ApiToken> {
    return this.tokens.revoke(params.id)
  }
}
