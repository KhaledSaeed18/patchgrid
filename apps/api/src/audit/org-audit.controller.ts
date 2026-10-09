import { Controller, Get, Query } from "@nestjs/common"
import { type AuditPage, auditQuerySchema } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"

import { RequirePermission } from "../authz/require-permission"
import { OrgAuditService } from "./org-audit.service"

class AuditQueryDto extends createZodDto(auditQuerySchema) {}

@Controller("org/audit")
export class OrgAuditController {
  constructor(private readonly audit: OrgAuditService) {}

  @Get()
  @RequirePermission("org:read_audit")
  list(@Query() query: AuditQueryDto): Promise<AuditPage> {
    return this.audit.list(query)
  }
}
