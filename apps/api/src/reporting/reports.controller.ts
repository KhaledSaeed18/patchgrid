import { Controller, Get, Query } from "@nestjs/common"
import { type BacklogReport, reportRangeQuerySchema, type SlaReport, type WorkloadReport } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"

import { RequirePermission } from "../authz/require-permission"
import { ReportsService } from "./reports.service"

class RangeQueryDto extends createZodDto(reportRangeQuerySchema) {}

/** `/reports` — the workspace's reports, from the reporting read side (ADR-0051). */
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("sla")
  @RequirePermission("report:read")
  sla(@Query() query: RangeQueryDto): Promise<SlaReport> {
    return this.reports.sla(query)
  }

  @Get("backlog")
  @RequirePermission("report:read")
  backlog(): Promise<BacklogReport> {
    return this.reports.backlog()
  }

  @Get("workload")
  @RequirePermission("report:read")
  workload(@Query() query: RangeQueryDto): Promise<WorkloadReport> {
    return this.reports.workload(query)
  }
}
