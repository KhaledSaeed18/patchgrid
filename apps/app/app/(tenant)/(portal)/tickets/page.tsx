import { ticketPageSchema } from "@patchgrid/contracts"
import { buttonVariants } from "@patchgrid/ui/components/button"
import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@/components/page-header"
import { TicketFeed } from "@/components/tickets/ticket-feed"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "My tickets" }

const QUERY = "view=mine&limit=25"

export default async function MyTicketsPage() {
  const first = await serverApi(`/tickets?${QUERY}`, {
    schema: ticketPageSchema,
  })
  return (
    <>
      <PageHeader
        title="My tickets"
        description="Everything you've raised, most recent first."
        action={
          <Link href="/tickets/new" className={buttonVariants()}>
            Raise a ticket
          </Link>
        }
      />
      <div className="px-6 py-6 md:px-10">
        <TicketFeed
          first={first}
          query={QUERY}
          columns="portal"
          empty={
            <div className="max-w-md py-10">
              <p className="font-medium">Nothing raised yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                When something is broken or you need something set up, raise a
                ticket and the support team will pick it up.
              </p>
              <Link
                href="/tickets/new"
                className={buttonVariants({ className: "mt-4" })}
              >
                Raise a ticket
              </Link>
            </div>
          }
        />
      </div>
    </>
  )
}
