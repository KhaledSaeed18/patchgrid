import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common"
import {
  createTeamRequestSchema,
  idSchema,
  setTeamLeadRequestSchema,
  type Team,
  type TeamDetail,
  updateTeamRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { TeamsService } from "./teams.service"

class TeamParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class TeamMemberParamsDto extends createZodDto(z.object({ id: idSchema, membershipId: idSchema })) {}
class CreateTeamDto extends createZodDto(createTeamRequestSchema) {}
class UpdateTeamDto extends createZodDto(updateTeamRequestSchema) {}
class SetLeadDto extends createZodDto(setTeamLeadRequestSchema) {}

/**
 * Teams (ADR-0025). Membership is a sub-resource put and deleted by id, so
 * adding someone twice is the same request twice. A lead passes the route's
 * filter for membership changes; the service decides it is THEIR team.
 */
@Controller("teams")
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission("team:read")
  list(): Promise<Team[]> {
    return this.teams.list()
  }

  @Get(":id")
  @RequirePermission("team:read")
  get(@Param() params: TeamParamsDto): Promise<TeamDetail> {
    return this.teams.get(params.id)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("team:write")
  create(@Body() body: CreateTeamDto): Promise<TeamDetail> {
    return this.teams.create(body)
  }

  @Patch(":id")
  @RequirePermission("team:write")
  update(@Param() params: TeamParamsDto, @Body() body: UpdateTeamDto): Promise<TeamDetail> {
    return this.teams.update(params.id, body)
  }

  @Put(":id/lead")
  @RequirePermission("team:write")
  setLead(@Param() params: TeamParamsDto, @Body() body: SetLeadDto): Promise<TeamDetail> {
    return this.teams.setLead(params.id, body.membershipId)
  }

  @Put(":id/members/:membershipId")
  @HttpCode(204)
  @RequirePermission("team:manage_own_members")
  async addMember(@Param() params: TeamMemberParamsDto): Promise<void> {
    await this.teams.addMember(params.id, params.membershipId)
  }

  @Delete(":id/members/:membershipId")
  @HttpCode(204)
  @RequirePermission("team:manage_own_members")
  async removeMember(@Param() params: TeamMemberParamsDto): Promise<void> {
    await this.teams.removeMember(params.id, params.membershipId)
  }
}
