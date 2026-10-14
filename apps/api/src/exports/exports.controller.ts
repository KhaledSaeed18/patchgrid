import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common"
import { type ExportDownload, idSchema, type OrgExport } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { ExportsService } from "./exports.service"

class ExportParamsDto extends createZodDto(z.object({ id: idSchema })) {}

/** `/org/exports` — the workspace's own data, out (ADR-0028, ADR-0044). */
@Controller("org/exports")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get()
  @RequirePermission("org:export")
  list(): Promise<OrgExport[]> {
    return this.exports.list()
  }

  /**
   * `202`: the export is queued, not made. Not `@Idempotent`: the daily
   * allowance already makes a retried request a `429`, never a second export.
   */
  @Post()
  @HttpCode(202)
  @RequirePermission("org:export")
  request(): Promise<OrgExport> {
    return this.exports.request()
  }

  @Get(":id/download")
  @RequirePermission("org:export")
  download(@Param() params: ExportParamsDto): Promise<ExportDownload> {
    return this.exports.download(params.id)
  }
}
