"use client"

import { type TicketPage, ticketPageSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useInfiniteQuery } from "@tanstack/react-query"

import { clientApi } from "@/lib/api/client"

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
}: {
  first: TicketPage
  query: string
  columns: "portal" | "console"
  empty: React.ReactNode
}) {
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

  if (tickets.length === 0) return <>{empty}</>
  return (
    <>
      <TicketTable tickets={tickets} columns={columns} />
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
