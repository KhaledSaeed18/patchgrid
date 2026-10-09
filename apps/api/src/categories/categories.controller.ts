import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import {
  type Category,
  categoryListQuerySchema,
  createCategoryRequestSchema,
  idSchema,
  updateCategoryRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { CategoriesService } from "./categories.service"
import { Idempotent } from "../common/idempotency/idempotency"

class ListDto extends createZodDto(categoryListQuerySchema) {}
class ParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class CreateDto extends createZodDto(createCategoryRequestSchema) {}
class UpdateDto extends createZodDto(updateCategoryRequestSchema) {}

/** The taxonomy. No DELETE: a category is deactivated, because tickets keep it (DOMAIN.md §5). */
@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission("category:read")
  list(@Query() query: ListDto): Promise<Category[]> {
    return this.categories.list(query.includeInactive)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("category:write")
  @Idempotent()
  create(@Body() body: CreateDto): Promise<Category> {
    return this.categories.create(body)
  }

  @Patch(":id")
  @RequirePermission("category:write")
  update(@Param() params: ParamsDto, @Body() body: UpdateDto): Promise<Category> {
    return this.categories.update(params.id, body)
  }
}
