import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common"
import {
  idSchema,
  requestSupportRequestSchema,
  type SupportEntry,
  supportCookieName,
  type SupportSession,
  platformOrgListQuerySchema,
  type PlatformOrgDetail,
  type PlatformOrgPage,
  setPlanRequestSchema,
  suspendOrgRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import type { Response } from "express"

import { PlatformRoute } from "../../common/decorators/route-markers"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import { BackofficeService } from "./backoffice.service"
import { PlatformSupportService } from "./platform-support.service"

class OrgParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class ListDto extends createZodDto(platformOrgListQuerySchema) {}
class SuspendDto extends createZodDto(suspendOrgRequestSchema) {}
class PlanDto extends createZodDto(setPlanRequestSchema) {}
class SupportParamsDto extends createZodDto(z.object({ id: idSchema, sessionId: idSchema })) {}
class RequestSupportDto extends createZodDto(requestSupportRequestSchema) {}

/** `/platform/orgs` — the back-office (RBAC.md §8, ADR-0040). Operators only; metadata only. */
@Controller("platform/orgs")
@PlatformRoute()
export class BackofficeController {
  constructor(
    private readonly backoffice: BackofficeService,
    private readonly support: PlatformSupportService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  @Get()
  list(@Query() query: ListDto): Promise<PlatformOrgPage> {
    return this.backoffice.list(query)
  }

  @Get(":id")
  get(@Param() params: OrgParamsDto): Promise<PlatformOrgDetail> {
    return this.backoffice.get(params.id)
  }

  @Post(":id/suspend")
  @HttpCode(200)
  suspend(@Param() params: OrgParamsDto, @Body() body: SuspendDto): Promise<PlatformOrgDetail> {
    return this.backoffice.suspend(params.id, body.reason)
  }

  @Post(":id/unsuspend")
  @HttpCode(200)
  unsuspend(@Param() params: OrgParamsDto): Promise<PlatformOrgDetail> {
    return this.backoffice.unsuspend(params.id)
  }

  @Get(":id/support")
  supportSessions(@Param() params: OrgParamsDto): Promise<SupportSession[]> {
    return this.support.list(params.id)
  }

  @Post(":id/support")
  @HttpCode(201)
  requestSupport(@Param() params: OrgParamsDto, @Body() body: RequestSupportDto): Promise<SupportSession> {
    return this.support.request(params.id, body.reason)
  }

  /** Sets `pg_st_<slug>` for the workspace's own hosts; the operator then opens it, read-only (ADR-0041). */
  @Post(":id/support/:sessionId/enter")
  @HttpCode(200)
  async enterSupport(@Param() params: SupportParamsDto, @Res({ passthrough: true }) response: Response): Promise<SupportEntry> {
    const entered = await this.support.enter(params.id, params.sessionId)
    response.cookie(supportCookieName(entered.slug), entered.token, { ...this.cookie(), maxAge: entered.maxAgeSeconds * 1000 })
    return { workspaceUrl: entered.workspaceUrl, expiresAt: entered.expiresAt }
  }

  /** Back to being no one in that workspace. */
  @Post(":id/support/leave")
  @HttpCode(204)
  async leaveSupport(@Param() params: OrgParamsDto, @Res({ passthrough: true }) response: Response): Promise<void> {
    response.clearCookie(supportCookieName(await this.support.slugOf(params.id)), this.cookie())
  }

  @Put(":id/plan")
  setPlan(@Param() params: OrgParamsDto, @Body() body: PlanDto): Promise<PlatformOrgDetail> {
    return this.backoffice.setPlan(params.id, body.plan)
  }

  private cookie() {
    return { domain: this.config.COOKIE_DOMAIN, path: "/", httpOnly: true, sameSite: "lax" as const, secure: this.config.isProduction }
  }
}
