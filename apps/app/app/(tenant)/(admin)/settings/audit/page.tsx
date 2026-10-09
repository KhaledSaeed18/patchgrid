import { auditPageSchema, memberPageSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { AuditLog } from "./audit-log"

export const metadata: Metadata = { title: "Audit log" }

export default async function AuditPage() {
  const [first, members] = await Promise.all([
    serverApi("/org/audit?limit=50", { schema: auditPageSchema }),
    serverApi("/members?limit=100&includeRemoved=true", {
      schema: memberPageSchema,
    }),
  ])
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to who is in this workspace and how it is set up, newest first. Entries can't be edited or deleted."
      />
      <AuditLog
        first={first}
        members={members.items.map((m) => ({ id: m.id, name: m.displayName }))}
      />
    </>
  )
}
