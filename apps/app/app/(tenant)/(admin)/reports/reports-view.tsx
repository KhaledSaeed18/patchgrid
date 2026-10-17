"use client"

import {
  type BacklogReport,
  backlogReportSchema,
  type ReportGroup,
  reportGroupSchema,
  type SlaReport,
  type SlaReportRow,
  slaReportSchema,
  type WorkloadReport,
  workloadReportSchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@patchgrid/ui/components/table"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"

import { csvCell, duration, percent, RANGE_DAYS, type RangeDays, rangeFor } from "./range"

const GROUP_LABEL: Record<ReportGroup, string> = {
  priority: "Priority",
  type: "Type",
  team: "Team",
  category: "Category",
  assignee: "Assignee",
}

/**
 * The reports (ADR-0051): SLA compliance by a chosen group over a chosen
 * range, the open backlog by age, and who holds the work. The first render is
 * the server's; changing the range or the group asks again.
 */
export function ReportsView({ initial }: { initial: { sla: SlaReport; backlog: BacklogReport; workload: WorkloadReport } }) {
  const [days, setDays] = useState<RangeDays>(30)
  const [groupBy, setGroupBy] = useState<ReportGroup>("priority")
  const first = days === 30 && groupBy === "priority"
  const range = rangeFor(days, new Date())
  const query = `from=${range.from}&to=${range.to}`

  const sla = useQuery({
    queryKey: ["reports", "sla", days, groupBy],
    queryFn: () => clientApi(`/reports/sla?${query}&groupBy=${groupBy}`, { schema: slaReportSchema }),
    ...(first ? { initialData: initial.sla } : {}),
  })
  const workload = useQuery({
    queryKey: ["reports", "workload", days],
    queryFn: () => clientApi(`/reports/workload?${query}`, { schema: workloadReportSchema }),
    ...(days === 30 ? { initialData: initial.workload } : {}),
  })
  const backlog = useQuery({
    queryKey: ["reports", "backlog"],
    queryFn: () => clientApi("/reports/backlog", { schema: backlogReportSchema }),
    initialData: initial.backlog,
  })

  return (
    <div className="grid gap-10 px-6 py-6 md:px-10">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect aria-label="Range" className="w-44" value={String(days)} onChange={(e) => setDays(Number(e.target.value) as RangeDays)}>
          {RANGE_DAYS.map((d) => (
            <option key={d} value={d}>
              Last {d === 365 ? "year" : `${String(d)} days`}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Group by"
          className="w-44"
          value={groupBy}
          onChange={(e) => {
            const parsed = reportGroupSchema.safeParse(e.target.value)
            if (parsed.success) setGroupBy(parsed.data)
          }}
        >
          {reportGroupSchema.options.map((g) => (
            <option key={g} value={g}>
              By {GROUP_LABEL[g].toLowerCase()}
            </option>
          ))}
        </NativeSelect>
        {sla.isFetching && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>

      {sla.data !== undefined && <SlaSection report={sla.data} groupBy={groupBy} />}
      {backlog.data !== undefined && <BacklogSection report={backlog.data} />}
      {workload.data !== undefined && <WorkloadSection report={workload.data} />}
    </div>
  )
}

/** The headline: what share of resolved tickets met their target, and how long resolution took. */
function Tiles({ total }: { total: SlaReportRow }) {
  const resolution = percent(total.resolution.met, total.resolution.met + total.resolution.breached)
  const response = percent(total.response.met, total.response.met + total.response.breached)
  const tiles = [
    { label: "Resolved within target", value: resolution === null ? "—" : `${String(resolution)}%`, note: `${String(total.resolution.breached)} missed` },
    { label: "Answered within target", value: response === null ? "—" : `${String(response)}%`, note: `${String(total.response.running)} still waiting` },
    { label: "Median time to resolve", value: duration(total.medianResolutionMinutes), note: `p90 ${duration(total.p90ResolutionMinutes)}` },
    { label: "Resolved", value: String(total.resolved), note: "in the range" },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">{t.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>
        </div>
      ))}
    </div>
  )
}

/** A share as a thin bar in one hue: magnitude, not status, so the number beside it carries the meaning. */
function Meter({ value, title }: { value: number | null; title: string }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
        {value !== null && <div className="h-full rounded-full bg-chart-3" style={{ width: `${String(value)}%` }} />}
      </div>
      <span className="w-12 text-right text-sm tabular-nums">{value === null ? "—" : `${String(value)}%`}</span>
    </div>
  )
}

function SlaSection({ report, groupBy }: { report: SlaReport; groupBy: ReportGroup }) {
  const download = () => {
    const header = ["group", "answered_met", "answered_missed", "awaiting_answer", "resolved_met", "resolved_missed", "resolved", "median_minutes", "p90_minutes"]
    const line = (r: SlaReportRow) =>
      [r.label, r.response.met, r.response.breached, r.response.running, r.resolution.met, r.resolution.breached, r.resolved, r.medianResolutionMinutes ?? "", r.p90ResolutionMinutes ?? ""]
        .map(csvCell)
        .join(",")
    const csv = [header.join(","), ...report.rows.map(line), line(report.total)].join("\n")
    const link = document.createElement("a")
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
    link.download = `sla-by-${groupBy}-${report.from.slice(0, 10)}-to-${report.to.slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  return (
    <section className="grid gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold">SLA compliance</h2>
        <Button variant="outline" size="sm" onClick={download}>
          Download CSV
        </Button>
      </div>
      <Tiles total={report.total} />
      {report.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tickets were raised or resolved in this range.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{GROUP_LABEL[groupBy]}</TableHead>
              <TableHead>Answered in time</TableHead>
              <TableHead>Resolved in time</TableHead>
              <TableHead className="text-right">Resolved</TableHead>
              <TableHead className="text-right">Median</TableHead>
              <TableHead className="text-right">p90</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((r) => {
              const answered = percent(r.response.met, r.response.met + r.response.breached)
              const resolved = percent(r.resolution.met, r.resolution.met + r.resolution.breached)
              return (
                <TableRow key={r.key ?? "none"}>
                  <TableCell className="font-medium">{r.label}</TableCell>
                  <TableCell>
                    <Meter value={answered} title={`${String(r.response.met)} answered in time, ${String(r.response.breached)} late, ${String(r.response.running)} waiting`} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Meter value={resolved} title={`${String(r.resolution.met)} resolved in time, ${String(r.resolution.breached)} late`} />
                      {r.resolution.breached > 0 && <Badge variant="destructive">{r.resolution.breached} missed</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.resolved}</TableCell>
                  <TableCell className="text-right tabular-nums">{duration(r.medianResolutionMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{duration(r.p90ResolutionMinutes)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

/** Open work by priority and age: counts, with a one-hue shade that grows with the count. */
function BacklogSection({ report }: { report: BacklogReport }) {
  const max = Math.max(1, ...report.rows.flatMap((r) => r.counts))
  const open = report.byType.reduce((n, t) => n + t.open, 0)
  return (
    <section className="grid gap-4">
      <h2 className="text-base font-semibold">
        Open backlog <span className="font-normal text-muted-foreground">· {open} open</span>
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Priority</TableHead>
            {report.buckets.map((b) => (
              <TableHead key={b} className="text-right">
                {b}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.rows.map((r) => (
            <TableRow key={r.priority}>
              <TableCell className="font-medium">{r.priority.charAt(0) + r.priority.slice(1).toLowerCase()}</TableCell>
              {r.counts.map((count, i) => (
                <TableCell key={report.buckets[i]} className="text-right tabular-nums">
                  <span
                    className="inline-block min-w-10 rounded px-2 py-0.5"
                    // One hue, more of it for more tickets: magnitude, so a sequential shade.
                    style={count === 0 ? undefined : { backgroundColor: `color-mix(in oklch, var(--chart-3) ${String(Math.round(15 + (count / max) * 45))}%, transparent)` }}
                  >
                    {count}
                  </span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

function WorkloadSection({ report }: { report: WorkloadReport }) {
  return (
    <section className="grid gap-4">
      <h2 className="text-base font-semibold">Who holds the work</h2>
      {report.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing open, and nothing resolved in this range.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Assignee</TableHead>
              <TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Open and late</TableHead>
              <TableHead className="text-right">Resolved in range</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((r) => (
              <TableRow key={r.membershipId ?? "unassigned"}>
                <TableCell className="font-medium">{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{r.open}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.breachedOpen > 0 ? <Badge variant="destructive">{r.breachedOpen}</Badge> : <span className="text-muted-foreground">0</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.resolvedInRange}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}
