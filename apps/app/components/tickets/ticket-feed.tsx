"use client"

import { type TicketPage, ticketPageSchema, type TicketSummary } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useState } from "react"

import { clientApi } from "@/lib/api/client"

import { BulkBar } from "./bulk-bar"
import { TicketTable } from "./ticket-table"

/**
 * A ticket list the server rendered the first page of, continued in the
 * browser with the cursor it returned (ADR-0012). `query` is the list's
 * query string without a cursor — it is also the cache key, so a different
 * view or filter is a different list.
 */
export function TicketFeed({
  first,
  query,
  columns,
  empty,
  bulk = false,
}: {
  first: TicketPage
  query: string
  columns: "portal" | "console"
  empty: React.ReactNode
  /** Rows can be picked for a bulk action (ADR-0052): agents' queues only. */
  bulk?: boolean
}) {
  // The version each picked row showed: what the bulk action sends back, so a ticket changed since is a conflict.
  const [picked, setPicked] = useState<Map<string, { version: number; number: string }>>(new Map())
  const feed = useInfiniteQuery({
    queryKey: ["tickets", query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query)
      if (pageParam !== null) params.set("cursor", pageParam)
      return clientApi(`/tickets?${params.toString()}`, {
        schema: ticketPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
  })
  const tickets = feed.data.pages.flatMap((p) => p.items)

  const selection = bulk
    ? {
        selected: new Set(picked.keys()),
        toggle: (ticket: TicketSummary) =>
          setPicked((current) => {
            const next = new Map(current)
            if (next.has(ticket.id)) next.delete(ticket.id)
            else next.set(ticket.id, { version: ticket.version, number: ticket.number })
            return next
          }),
        setAll: (shown: readonly TicketSummary[], on: boolean) =>
          setPicked((current) => {
            const next = new Map(current)
            for (const t of shown) {
              if (on) next.set(t.id, { version: t.version, number: t.number })
              else next.delete(t.id)
            }
            return next
          }),
      }
    : undefined

  if (tickets.length === 0) return <>{empty}</>
  return (
    <>
      {bulk && picked.size > 0 && (
        <BulkBar
          picked={[...picked].map(([id, row]) => ({ id, ...row }))}
          onChanged={() => void feed.refetch()}
          onFinished={() => setPicked(new Map())}
        />
      )}
      <TicketTable tickets={tickets} columns={columns} {...(selection === undefined ? {} : { selection })} />
      {feed.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage && <Spinner />}
          Show more
        </Button>
      )}
    </>
  )
}
