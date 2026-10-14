import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common"
import {
  idSchema,
  platformOrgListQuerySchema,
  type PlatformOrgDetail,
  type PlatformOrgPage,
  setPlanRequestSchema,
  suspendOrgRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { PlatformRoute } from "../../common/decorators/route-markers"
import { BackofficeService } from "./backoffice.service"

class OrgParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class ListDto extends createZodDto(platformOrgListQuerySchema) {}
class SuspendDto extends createZodDto(suspendOrgRequestSchema) {}
class PlanDto extends createZodDto(setPlanRequestSchema) {}

/** `/platform/orgs` — the back-office (RBAC.md §8, ADR-0040). Operators only; metadata only. */
@Controller("platform/orgs")
@PlatformRoute()
export class BackofficeController {
  constructor(private readonly backoffice: BackofficeService) {}

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

  @Put(":id/plan")
  setPlan(@Param() params: OrgParamsDto, @Body() body: PlanDto): Promise<PlatformOrgDetail> {
    return this.backoffice.setPlan(params.id, body.plan)
  }
}
