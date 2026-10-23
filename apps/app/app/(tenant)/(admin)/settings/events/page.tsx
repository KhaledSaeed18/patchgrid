import { deadLetterListSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { DeadLetterList } from "./dead-letter-list"

export const metadata: Metadata = { title: "Event delivery" }

export default async function EventsPage() {
  const list = await serverApi("/org/events/dead-letters", {
    schema: deadLetterListSchema,
  })
  return (
    <>
      <PageHeader
        title="Event delivery"
        description="Every change in the workspace becomes an event that notifications, webhooks and reports each read in turn. One that keeps failing is set aside here so the rest keep flowing; once whatever broke it is fixed, replay it."
      />
      <DeadLetterList initial={list.items} />
    </>
  )
}
