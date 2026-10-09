import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import {
  type AcceptInvitationResponse,
  acceptInvitationRequestSchema,
  acceptNewInvitationRequestSchema,
  createInvitationRequestSchema,
  idSchema,
  type Invitation,
  type InvitationPreview,
  invitationTokenQuerySchema,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { ActorService } from "../../auth/actor"
import { clientOf } from "../../auth/auth.controller"
import { CookieService } from "../../auth/cookies"
import { RequirePermission } from "../../authz/require-permission"
import { Public, TenantOptional } from "../../common/decorators/route-markers"
import { InvitationAcceptanceService } from "../acceptance/invitation-acceptance.service"
import { InvitationsService } from "./invitations.service"
import { Idempotent } from "../../common/idempotency/idempotency"

class CreateInvitationDto extends createZodDto(createInvitationRequestSchema) {}
class InvitationParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class TokenQueryDto extends createZodDto(invitationTokenQuerySchema) {}
class AcceptDto extends createZodDto(acceptInvitationRequestSchema) {}
class AcceptNewDto extends createZodDto(acceptNewInvitationRequestSchema) {}

/**
 * Invitations (ADR-0033, TENANCY.md §5). Issuing and revoking are tenant-bound
 * admin actions; the three acceptance routes are tenant-less, because whoever
 * holds the link is not a member yet. Those are throttled like the identity
 * routes: a token is 256 bits, but the per-address limit is what makes
 * guessing pointless rather than merely improbable.
 */
@Controller("invitations")
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly acceptance: InvitationAcceptanceService,
    private readonly cookies: CookieService,
    private readonly actors: ActorService,
  ) {}

  @Get()
  @RequirePermission("member:invite")
  list(): Promise<Invitation[]> {
    return this.invitations.listPending()
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("member:invite")
  @Idempotent()
  create(@Body() body: CreateInvitationDto): Promise<Invitation> {
    return this.invitations.create(body)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("member:invite")
  async revoke(@Param() params: InvitationParamsDto): Promise<void> {
    await this.invitations.revoke(params.id)
  }

  /** What the acceptance page shows; only a valid token gets an answer. */
  @Get("preview")
  @Public()
  @Throttle({ ip: { limit: 10, ttl: 60_000 } })
  preview(@Query() query: TokenQueryDto): Promise<InvitationPreview> {
    return this.acceptance.preview(query.token)
  }

  /** A signed-in holder joins; the response opens the workspace. */
  @Post("accept")
  @TenantOptional()
  @HttpCode(200)
  @Throttle({ ip: { limit: 10, ttl: 60_000 } })
  async accept(
    @Body() body: AcceptDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AcceptInvitationResponse> {
    const identity = this.actors.requireIdentity()
    const result = await this.acceptance.accept(identity.userId, body.token, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }

  /** A holder with no account creates one and joins; the response signs them in. */
  @Post("accept-new")
  @Public()
  @HttpCode(201)
  @Throttle({ ip: { limit: 10, ttl: 60_000 } })
  async acceptNew(
    @Body() body: AcceptNewDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AcceptInvitationResponse> {
    const result = await this.acceptance.acceptNew(body.token, body.name, body.password, clientOf(request))
    this.cookies.set(response, result.cookies)
    return result.response
  }
}
