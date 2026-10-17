import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common"
import { createSavedViewRequestSchema, idSchema, type SavedView } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { SavedViewsService } from "./saved-views.service"

class ViewParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class CreateViewDto extends createZodDto(createSavedViewRequestSchema) {}

/** `/views` — saved ticket lists (ADR-0052). */
@Controller("views")
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get()
  @RequirePermission("view:manage")
  list(): Promise<SavedView[]> {
    return this.views.list()
  }

  @Post()
  @RequirePermission("view:manage")
  create(@Body() body: CreateViewDto): Promise<SavedView> {
    return this.views.create(body)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("view:manage")
  async remove(@Param() params: ViewParamsDto): Promise<void> {
    await this.views.remove(params.id)
  }
}
