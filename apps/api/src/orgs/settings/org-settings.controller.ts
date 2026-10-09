import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from "@nestjs/common"
import {
  type ChangeSlugResponse,
  changeSlugRequestSchema,
  type OrganizationSettings,
  updateOrganizationSettingsRequestSchema,
  type Usage,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"

import { clientOf } from "../../auth/auth.controller"
import { CookieService } from "../../auth/cookies"
import { RequirePermission } from "../../authz/require-permission"
import { OrgSettingsService } from "./org-settings.service"

class UpdateSettingsDto extends createZodDto(updateOrganizationSettingsRequestSchema) {}
class ChangeSlugDto extends createZodDto(changeSlugRequestSchema) {}

/** The current workspace's settings. `/org`, singular: there is only ever the one the session names. */
@Controller("org")
export class OrgSettingsController {
  constructor(
    private readonly settings: OrgSettingsService,
    private readonly cookies: CookieService,
  ) {}

  @Get("settings")
  @RequirePermission("org:read_settings")
  get(): Promise<OrganizationSettings> {
    return this.settings.get()
  }

  @Get("usage")
  @RequirePermission("org:read_settings")
  usage(): Promise<Usage> {
    return this.settings.usage()
  }

  @Patch("settings")
  @RequirePermission("org:update_settings")
  update(@Body() body: UpdateSettingsDto): Promise<OrganizationSettings> {
    return this.settings.update(body)
  }

  /** Sets the new workspace's cookie pair and clears the old one in the same response. */
  @Post("slug")
  @HttpCode(200)
  @RequirePermission("org:change_slug")
  async changeSlug(
    @Body() body: ChangeSlugDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChangeSlugResponse> {
    const result = await this.settings.changeSlug(body.slug, clientOf(request))
    this.cookies.clear(response, result.clear)
    this.cookies.set(response, result.set)
    return result.response
  }
}
