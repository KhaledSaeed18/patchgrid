import { Controller, Get, Query } from "@nestjs/common"
import { inboundEmailListQuerySchema, type InboundEmailPage } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"

import { RequirePermission } from "../authz/require-permission"
import { InboundLogService } from "./inbound-log.service"

class ListDto extends createZodDto(inboundEmailListQuerySchema) {}

/** `GET /org/inbound-emails` — the workspace's inbound log, newest first (ADR-0027). */
@Controller("org/inbound-emails")
export class InboundLogController {
  constructor(private readonly log: InboundLogService) {}

  @Get()
  @RequirePermission("org:read_audit")
  list(@Query() query: ListDto): Promise<InboundEmailPage> {
    return this.log.list(query)
  }
}
