import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"

import { Inbox } from "./inbox"

export const metadata: Metadata = { title: "Notifications" }

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="What happened on the tickets you raised, work on or watch. A burst on one ticket is folded into a single line."
      />
      <div className="px-6 py-6 md:px-10">
        <Inbox />
      </div>
    </>
  )
}
