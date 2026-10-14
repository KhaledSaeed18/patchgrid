import {
  inboundEmailPageSchema,
  organizationSettingsSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { InboundLog } from "./inbound-log"

export const metadata: Metadata = { title: "Inbound email" }

export default async function InboundPage() {
  const [first, settings] = await Promise.all([
    serverApi("/org/inbound-emails?limit=50", {
      schema: inboundEmailPageSchema,
    }),
    serverApi("/org/settings", { schema: organizationSettingsSchema }),
  ])
  return (
    <>
      <PageHeader
        title="Inbound email"
        description={
          <>
            What arrived at{" "}
            <span className="font-mono">{settings.inboundAddress}</span>, newest
            first — and why each message was taken or left out. Only members
            whose mail passes DMARC can raise or reply to tickets by email.
          </>
        }
      />
      <InboundLog first={first} />
    </>
  )
}
