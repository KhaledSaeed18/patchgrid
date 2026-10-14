import { supportSessionSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { SupportAccess } from "./support-access"

export const metadata: Metadata = { title: "Support access" }

export default async function SupportPage() {
  const sessions = await serverApi("/org/support-sessions", {
    schema: z.array(supportSessionSchema),
  })
  return (
    <>
      <PageHeader
        title="Support access"
        description="Patchgrid support can read this workspace only when an owner says so, for as long as an owner says, and only read. Every page they open is in your audit log."
      />
      <SupportAccess initial={sessions} />
    </>
  )
}
