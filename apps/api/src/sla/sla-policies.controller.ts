import { Body, Controller, Get, Param, Patch } from "@nestjs/common"
import { idSchema, type SlaPolicy, updateSlaPolicyRequestSchema } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { SlaPoliciesService } from "./sla-policies.service"

class ParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class UpdateDto extends createZodDto(updateSlaPolicyRequestSchema) {}

/** The eight policies are provisioned with the workspace; they are edited, never created or deleted. */
@Controller("sla-policies")
export class SlaPoliciesController {
  constructor(private readonly policies: SlaPoliciesService) {}

  @Get()
  @RequirePermission("sla:read")
  list(): Promise<SlaPolicy[]> {
    return this.policies.list()
  }

  @Patch(":id")
  @RequirePermission("sla:write")
  update(@Param() params: ParamsDto, @Body() body: UpdateDto): Promise<SlaPolicy> {
    return this.policies.update(params.id, body)
  }
}
