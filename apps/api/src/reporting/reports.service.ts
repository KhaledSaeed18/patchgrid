import { Injectable } from "@nestjs/common"
import {
  BACKLOG_BUCKETS,
  type BacklogReport,
  prioritySchema,
  type ReportRangeQuery,
  type SlaReport,
  type SlaReportRow,
  type WorkloadReport,
} from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { ReportingRepository, type SlaRow } from "./repositories/reporting.repository"

/**
 * The workspace's reports (ADR-0051), read from the facts, never the live
 * tables. Each report is one logical read, so one transaction.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly reporting: ReportingRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async sla(query: ReportRangeQuery): Promise<SlaReport> {
    const orgId = this.read()
    const from = new Date(query.from)
    const to = new Date(query.to)
    const { rows, percentiles } = await this.prisma.transaction(async () => ({
      rows: await this.reporting.sla(orgId, from, to, query.groupBy),
      percentiles: await this.reporting.resolutionPercentiles(orgId, from, to),
    }))
    const sum = (pick: (r: SlaRow) => number) => rows.reduce((n, r) => n + pick(r), 0)
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      groupBy: query.groupBy,
      rows: rows.map(toRow),
      total: toRow({
        key: null,
        label: "All tickets",
        responseMet: sum((r) => r.responseMet),
        responseBreached: sum((r) => r.responseBreached),
        responseRunning: sum((r) => r.responseRunning),
        resolutionMet: sum((r) => r.resolutionMet),
        resolutionBreached: sum((r) => r.resolutionBreached),
        resolved: sum((r) => r.resolved),
        median: percentiles.median,
        p90: percentiles.p90,
      }),
    }
  }

  async backlog(): Promise<BacklogReport> {
    const orgId = this.read()
    const { byPriority, byType } = await this.prisma.transaction(() => this.reporting.backlog(orgId, this.clock.now()))
    return {
      buckets: [...BACKLOG_BUCKETS],
      rows: prioritySchema.options.map((priority) => ({
        priority,
        counts: BACKLOG_BUCKETS.map((_, bucket) => byPriority.find((r) => r.priority === priority && r.bucket === bucket)?.open ?? 0),
      })),
      byType,
    }
  }

  async workload(query: Pick<ReportRangeQuery, "from" | "to">): Promise<WorkloadReport> {
    const orgId = this.read()
    const from = new Date(query.from)
    const to = new Date(query.to)
    const rows = await this.prisma.transaction(() => this.reporting.workload(orgId, from, to))
    return { from: from.toISOString(), to: to.toISOString(), rows }
  }

  private read(): string {
    this.permissions.assert(this.actors.requireTenantActor(), "report:read")
    return this.tenant.requireOrgId()
  }
}

/** Percentiles arrive as floats; a report shows whole minutes. */
function toRow(row: SlaRow): SlaReportRow {
  const minutes = (value: number | null) => (value === null ? null : Math.round(Number(value)))
  return {
    key: row.key,
    label: row.label,
    response: { met: row.responseMet, breached: row.responseBreached, running: row.responseRunning },
    resolution: { met: row.resolutionMet, breached: row.resolutionBreached },
    resolved: row.resolved,
    medianResolutionMinutes: minutes(row.median),
    p90ResolutionMinutes: minutes(row.p90),
  }
}
