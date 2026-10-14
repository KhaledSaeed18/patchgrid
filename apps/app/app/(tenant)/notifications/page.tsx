import { Button } from "@patchgrid/ui/components/button"
import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@/components/page-header"

import { Inbox } from "./inbox"

export const metadata: Metadata = { title: "Notifications" }

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="What happened on the tickets you raised, work on or watch. A burst on one ticket is folded into a single line."
        action={
          <Button
            variant="outline"
            size="sm"
            render={<Link href="/notifications/preferences" />}
          >
            Email preferences
          </Button>
        }
      />
      <div className="px-6 py-6 md:px-10">
        <Inbox />
      </div>
    </>
  )
}
