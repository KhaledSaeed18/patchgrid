import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import {
  type AssetDetail,
  assetListQuerySchema,
  type AssetPage,
  createAssetRequestSchema,
  idSchema,
  updateAssetRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { Idempotent } from "../common/idempotency/idempotency"
import { AssetsService } from "./assets.service"

class AssetParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class AssetListQueryDto extends createZodDto(assetListQuerySchema) {}
class CreateAssetDto extends createZodDto(createAssetRequestSchema) {}
class UpdateAssetDto extends createZodDto(updateAssetRequestSchema) {}

/**
 * The asset register (DOMAIN.md §9.3). `asset:read` is the route's filter for
 * reads — a requester holds it for their own assets — and the service decides
 * which. The tickets for an asset are `GET /tickets?view=all&assetId=…`, so
 * they are scoped exactly as every other ticket list is.
 */
@Controller("assets")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermission("asset:read")
  list(@Query() query: AssetListQueryDto): Promise<AssetPage> {
    return this.assets.list(query)
  }

  @Get(":id")
  @RequirePermission("asset:read")
  get(@Param() params: AssetParamsDto): Promise<AssetDetail> {
    return this.assets.get(params.id)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("asset:write")
  @Idempotent()
  create(@Body() body: CreateAssetDto): Promise<AssetDetail> {
    return this.assets.create(body)
  }

  @Patch(":id")
  @RequirePermission("asset:write")
  update(@Param() params: AssetParamsDto, @Body() body: UpdateAssetDto): Promise<AssetDetail> {
    return this.assets.update(params.id, body)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("asset:delete")
  async remove(@Param() params: AssetParamsDto): Promise<void> {
    await this.assets.remove(params.id)
  }
}
