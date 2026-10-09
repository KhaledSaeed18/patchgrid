import {
  ticketPageSchema,
  ticketSearchResultSchema,
  ticketStatusSchema,
  type TicketView,
  ticketViewSchema,
} from "@patchgrid/contracts"
import { cn } from "@patchgrid/ui/lib/utils"
import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@/components/page-header"
import { TicketFeed } from "@/components/tickets/ticket-feed"
import { TicketTable } from "@/components/tickets/ticket-table"
import { serverApi } from "@/lib/api/server"

import { QueueFilters } from "./queue-filters"

export const metadata: Metadata = { title: "Queues" }

const QUEUES: { view: Exclude<TicketView, "mine">; label: string }[] = [
  { view: "assigned", label: "Assigned to me" },
  { view: "teams", label: "My teams" },
  { view: "unassigned", label: "Unassigned" },
  { view: "open", label: "All open" },
]

/**
 * The agent console. Everything that decides what is listed is in the URL —
 * queue, status, search — so a view is a link a colleague can open and see
 * the same thing, within their own visibility.
 */
export default async function QueuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (key: string) =>
    typeof params[key] === "string" ? params[key] : undefined
  const parsedView = ticketViewSchema.safeParse(one("view"))
  const view =
    parsedView.success && parsedView.data !== "mine"
      ? parsedView.data
      : "assigned"
  const parsedStatus = ticketStatusSchema.safeParse(one("status"))
  const status = parsedStatus.success ? parsedStatus.data : undefined
  const q = one("q")?.trim() ?? ""

  const query = new URLSearchParams({ view, limit: "25" })
  if (status !== undefined) query.set("status", status)

  return (
    <>
      <PageHeader
        title="Queues"
        description="Open work you can see, newest first. Deadlines count down to the next target: first response, then resolution."
      />
      <div className="px-6 py-6 md:px-10">
        <nav
          aria-label="Queues"
          className="flex flex-wrap gap-1 border-b border-border"
        >
          {QUEUES.map((queue) => {
            const href = new URLSearchParams({ view: queue.view })
            if (status !== undefined) href.set("status", status)
            const current = q === "" && queue.view === view
            return (
              <Link
                key={queue.view}
                href={`/queues?${href.toString()}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm",
                  current
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {queue.label}
              </Link>
            )
          })}
        </nav>
        <QueueFilters view={view} status={status} q={q} />
        <div className="mt-4">
          {q === "" ? (
            <TicketFeed
              key={query.toString()}
              first={await serverApi(`/tickets?${query.toString()}`, {
                schema: ticketPageSchema,
              })}
              query={query.toString()}
              columns="console"
              empty={
                <p className="py-10 text-sm text-muted-foreground">
                  Nothing here
                  {status === undefined ? "" : " with that status"}. Try another
                  queue.
                </p>
              }
            />
          ) : (
            <SearchResults q={q} />
          )}
        </div>
      </div>
    </>
  )
}

async function SearchResults({ q }: { q: string }) {
  const result = await serverApi(
    `/tickets/search?${new URLSearchParams({ q, limit: "50" }).toString()}`,
    { schema: ticketSearchResultSchema }
  )
  if (result.items.length === 0) {
    return (
      <p className="py-10 text-sm text-muted-foreground">
        No tickets you can see match &ldquo;{q}&rdquo;. Search looks at titles,
        descriptions and ticket numbers like INC-42.
      </p>
    )
  }
  return <TicketTable tickets={result.items} columns="console" />
}
