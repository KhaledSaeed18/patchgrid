import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import {
  type CreateOrganizationResponse,
  createOrganizationRequestSchema,
  type SlugAvailability,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { ActorService } from "../auth/actor"
import { clientOf } from "../auth/auth.controller"
import { CookieService } from "../auth/cookies"
import { Public, TenantOptional } from "../common/decorators/route-markers"
import { ProvisioningService } from "./provisioning/provisioning.service"

class CreateOrganizationDto extends createZodDto(createOrganizationRequestSchema) {}
/** Any string: the answer to "not a slug" is `available: false` with the reason, never a 400. */
class SlugQueryDto extends createZodDto(z.object({ slug: z.string().max(128) })) {}

/**
 * Workspace creation and the live slug check. Both tenant-less (ARCHITECTURE.md
 * §Request pipeline): the signup form calls the check before any account
 * exists, and creation is what gives a `pg_id` holder their first tenant.
 */
@Controller("orgs")
export class OrgsController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  /** Public and tight: slug existence is accepted risk R-2, enumerating it should be slow. */
  @Get("slug-available")
  @Public()
  @Throttle({ ip: { limit: 30, ttl: 60_000 } })
  availability(@Query() query: SlugQueryDto): Promise<SlugAvailability> {
    return this.provisioning.availability(query.slug)
  }

  /** `201` with the new workspace's cookie pair already set. */
  @Post()
  @TenantOptional()
  @HttpCode(201)
  async create(
    @Body() body: CreateOrganizationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateOrganizationResponse> {
    const identity = this.actors.requireIdentity()
    const result = await this.provisioning.create(identity.userId, body, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }
}
