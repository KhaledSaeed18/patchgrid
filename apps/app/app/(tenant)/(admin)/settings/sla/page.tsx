import { slaPolicySchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { SlaTargets } from "./sla-targets"

export const metadata: Metadata = { title: "SLA targets" }

export default async function SlaPage() {
  const policies = await serverApi("/sla-policies", {
    schema: z.array(slaPolicySchema),
  })
  return (
    <>
      <PageHeader
        title="SLA targets"
        description="How quickly each priority must get a first response and a resolution, around the clock. The assignee and their team lead are warned before a target is missed."
      />
      <SlaTargets initial={policies} />
    </>
  )
}
