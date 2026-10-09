import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import {
  changeRoleRequestSchema,
  idSchema,
  type Member,
  memberListQuerySchema,
  type MemberPage,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { MembersService } from "./members.service"

class MemberListQueryDto extends createZodDto(memberListQuerySchema) {}
class MemberParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class ChangeRoleDto extends createZodDto(changeRoleRequestSchema) {}

/**
 * The members of the current workspace (ADR-0033). Each route names the
 * role-level permission as a first filter; the service decides on the target
 * member — "not an owner, never yourself" cannot be answered from a route.
 * State changes are verbs, not a writable `status` field.
 */
@Controller("members")
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission("member:read")
  list(@Query() query: MemberListQueryDto): Promise<MemberPage> {
    return this.members.list(query)
  }

  @Get(":id")
  @RequirePermission("member:read")
  get(@Param() params: MemberParamsDto): Promise<Member> {
    return this.members.get(params.id)
  }

  @Patch(":id/role")
  @RequirePermission("member:update_role")
  changeRole(@Param() params: MemberParamsDto, @Body() body: ChangeRoleDto): Promise<Member> {
    return this.members.changeRole(params.id, body.role)
  }

  @Post(":id/disable")
  @HttpCode(200)
  @RequirePermission("member:disable")
  disable(@Param() params: MemberParamsDto): Promise<Member> {
    return this.members.disable(params.id)
  }

  @Post(":id/enable")
  @HttpCode(200)
  @RequirePermission("member:disable")
  enable(@Param() params: MemberParamsDto): Promise<Member> {
    return this.members.enable(params.id)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("member:remove")
  async remove(@Param() params: MemberParamsDto): Promise<void> {
    await this.members.remove(params.id)
  }
}
