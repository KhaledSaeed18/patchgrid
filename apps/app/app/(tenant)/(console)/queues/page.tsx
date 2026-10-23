import {
  meSchema,
  prioritySchema,
  ticketPageSchema,
  ticketSearchResultSchema,
  ticketSortSchema,
  ticketStatusSchema,
  ticketTypeSchema,
  type TicketView,
  ticketViewSchema,
} from "@patchgrid/contracts"
import { cn } from "@patchgrid/ui/lib/utils"
import type { Metadata } from "next"
import Link from "next/link"

import { LiveRefresh } from "@/components/live-refresh"
import { PageHeader } from "@/components/page-header"
import { TicketFeed } from "@/components/tickets/ticket-feed"
import { TicketTable } from "@/components/tickets/ticket-table"
import { serverApi } from "@/lib/api/server"

import { QueueFilters } from "./queue-filters"
import { SavedViews } from "./saved-views"

export const metadata: Metadata = { title: "Queues" }

const QUEUES: { view: Exclude<TicketView, "mine">; label: string }[] = [
  { view: "assigned", label: "Assigned to me" },
  { view: "teams", label: "My teams" },
  { view: "unassigned", label: "Unassigned" },
  { view: "open", label: "All open" },
  { view: "approvals", label: "Awaiting my approval" },
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
  const me = await serverApi("/me", { schema: meSchema })
  // A support session (ADR-0041) is no one's assignee, in no team, and
  // decides nothing: it reads the workspace's open work.
  const operator = me.support?.kind === "operator"
  // The approvals queue only for those who could ever decide on a change.
  const queues = QUEUES.filter((queue) =>
    operator
      ? queue.view === "unassigned" || queue.view === "open"
      : queue.view !== "approvals" ||
        me.permissions.includes("ticket:approve_change")
  )
  const parsedView = ticketViewSchema.safeParse(one("view"))
  const view =
    parsedView.success && queues.some((queue) => queue.view === parsedView.data)
      ? parsedView.data
      : operator
        ? "open"
        : "assigned"
  const parsedType = ticketTypeSchema.safeParse(one("type"))
  const type =
    parsedType.success && view !== "approvals" ? parsedType.data : undefined
  const parsedStatus = ticketStatusSchema.safeParse(one("status"))
  const status = parsedStatus.success ? parsedStatus.data : undefined
  const parsedPriority = prioritySchema.safeParse(one("priority"))
  const priority =
    parsedPriority.success && view !== "approvals"
      ? parsedPriority.data
      : undefined
  const parsedSort = ticketSortSchema.safeParse(one("sort"))
  const sort = parsedSort.success ? parsedSort.data : "newest"
  const q = one("q")?.trim() ?? ""

  const query = new URLSearchParams({ view, limit: "25" })
  if (type !== undefined) query.set("type", type)
  if (status !== undefined) query.set("status", status)
  if (priority !== undefined) query.set("priority", priority)
  if (sort !== "newest") query.set("sort", sort)

  return (
    <>
      <LiveRefresh delay={1_000} />
      <PageHeader
        title="Queues"
        description="Open work you can see. Deadlines count down to the next target: first response, then resolution."
      />
      <div className="px-6 py-6 md:px-10">
        <nav
          aria-label="Queues"
          className="flex flex-wrap gap-1 border-b border-border"
        >
          {queues.map((queue) => {
            const href = new URLSearchParams({ view: queue.view })
            if (type !== undefined && queue.view !== "approvals")
              href.set("type", type)
            if (status !== undefined && queue.view !== "approvals")
              href.set("status", status)
            if (priority !== undefined && queue.view !== "approvals")
              href.set("priority", priority)
            if (sort !== "newest") href.set("sort", sort)
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
        <QueueFilters
          view={view}
          type={type}
          status={status}
          priority={priority}
          sort={sort}
          q={q}
        />
        {!operator &&
          me.permissions.includes("view:manage") &&
          view !== "approvals" &&
          view !== "mine" &&
          view !== "all" && (
            <SavedViews
              current={{
                view,
                sort,
                ...(type === undefined ? {} : { type }),
                ...(status === undefined ? {} : { status }),
                ...(priority === undefined ? {} : { priority }),
              }}
            />
          )}
        <div className="mt-4">
          {q === "" ? (
            <TicketFeed
              key={query.toString()}
              first={await serverApi(`/tickets?${query.toString()}`, {
                schema: ticketPageSchema,
              })}
              query={query.toString()}
              columns="console"
              bulk={!operator && me.permissions.includes("ticket:bulk")}
              empty={
                <p className="py-10 text-sm text-muted-foreground">
                  {view === "approvals"
                    ? "No changes are waiting on you. Changes for teams you lead, and every change if you are an admin, land here once submitted."
                    : `Nothing here${status === undefined ? "" : " with that status"}. Try another queue.`}
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
