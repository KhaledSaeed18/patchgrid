import { backlogReportSchema, slaReportSchema, workloadReportSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { rangeFor } from "./range"
import { ReportsView } from "./reports-view"

export const metadata: Metadata = { title: "Reports" }

export default async function ReportsPage() {
  const range = rangeFor(30, new Date())
  const query = `from=${range.from}&to=${range.to}`
  const [sla, backlog, workload] = await Promise.all([
    serverApi(`/reports/sla?${query}&groupBy=priority`, { schema: slaReportSchema }),
    serverApi("/reports/backlog", { schema: backlogReportSchema }),
    serverApi(`/reports/workload?${query}`, { schema: workloadReportSchema }),
  ])
  return (
    <>
      <PageHeader
        title="Reports"
        description="Are tickets answered and resolved within their targets, how old is the open work, and who holds it. Reports read from a copy kept beside the tickets, refreshed within seconds of every change."
      />
      <ReportsView initial={{ sla, backlog, workload }} />
    </>
  )
}
