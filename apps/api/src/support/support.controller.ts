import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common"
import { grantSupportRequestSchema, idSchema, type SupportSession } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { SupportService } from "./support.service"

class SessionParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class GrantDto extends createZodDto(grantSupportRequestSchema) {}

/** `/org/support-sessions` — the workspace's side of support access (ADR-0020, ADR-0041). */
@Controller("org/support-sessions")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @RequirePermission("support:read_sessions")
  list(): Promise<SupportSession[]> {
    return this.support.list()
  }

  @Post(":id/grant")
  @HttpCode(200)
  @RequirePermission("support:grant_access")
  grant(@Param() params: SessionParamsDto, @Body() body: GrantDto): Promise<SupportSession> {
    return this.support.grant(params.id, body.hours)
  }

  @Post(":id/decline")
  @HttpCode(200)
  @RequirePermission("support:grant_access")
  decline(@Param() params: SessionParamsDto): Promise<SupportSession> {
    return this.support.decline(params.id)
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @RequirePermission("support:revoke_access")
  revoke(@Param() params: SessionParamsDto): Promise<SupportSession> {
    return this.support.revoke(params.id)
  }
}
