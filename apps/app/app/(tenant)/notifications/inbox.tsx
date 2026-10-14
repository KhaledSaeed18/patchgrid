"use client"

import { notificationPageSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { cn } from "@patchgrid/ui/lib/utils"
import { useInfiniteQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"

import {
  useMarkAllRead,
  useMarkRead,
} from "@/components/notifications/mutations"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"

type Filter = "all" | "unread"

/**
 * Every notification, latest activity first, continued with the server's
 * cursor. The list is the source of truth and the live stream only prompts a
 * refetch (through the `["notifications"]` key), so a missed event is harmless.
 */
export function Inbox() {
  const [filter, setFilter] = useState<Filter>("all")
  const markRead = useMarkRead()
  const markAll = useMarkAllRead()
  const feed = useInfiniteQuery({
    queryKey: ["notifications", "inbox", filter],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        unread: String(filter === "unread"),
        limit: "25",
      })
      if (pageParam !== null) params.set("cursor", pageParam)
      return clientApi(`/notifications?${params.toString()}`, {
        schema: notificationPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
  const items = feed.data?.pages.flatMap((p) => p.items) ?? []
  const unread = feed.data?.pages[0]?.unreadCount ?? 0

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border">
        <div role="tablist" aria-label="Filter" className="flex gap-1">
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                filter === value
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {value === "all"
                ? "All"
                : `Unread${unread > 0 ? ` (${unread})` : ""}`}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </div>
      {feed.isPending ? (
        <p className="py-10 text-sm text-muted-foreground">Loading…</p>
      ) : feed.isError ? (
        <p role="alert" className="py-10 text-sm text-destructive">
          The inbox couldn&apos;t be loaded.
        </p>
      ) : items.length === 0 ? (
        <p className="py-10 text-sm text-muted-foreground">
          {filter === "unread" ? "Nothing unread." : "Nothing yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((n) => {
            const row = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "mt-2 size-2 shrink-0 rounded-full",
                    n.readAt === null ? "bg-primary" : "bg-transparent"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm",
                      n.readAt === null
                        ? "font-medium"
                        : "text-muted-foreground"
                    )}
                  >
                    {n.title}
                    {n.count > 1 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ×{n.count}
                      </span>
                    )}
                    {n.readAt === null && (
                      <span className="sr-only"> (unread)</span>
                    )}
                  </span>
                  {n.body !== null && (
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {n.body}
                    </span>
                  )}
                  <RelativeTime
                    at={n.updatedAt}
                    className="mt-0.5 block text-xs text-muted-foreground"
                  />
                </span>
              </>
            )
            return (
              <li key={n.id} className="flex items-start gap-2">
                {n.ticketId !== null ? (
                  <Link
                    href={`/tickets/${n.ticketId}`}
                    onClick={() => {
                      if (n.readAt === null) markRead.mutate(n.id)
                    }}
                    className="flex min-w-0 flex-1 items-start gap-3 py-3 hover:bg-muted/40"
                  >
                    {row}
                  </Link>
                ) : (
                  <div className="flex min-w-0 flex-1 items-start gap-3 py-3">
                    {row}
                  </div>
                )}
                {n.readAt === null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    disabled={markRead.isPending}
                    onClick={() => markRead.mutate(n.id)}
                  >
                    Mark read
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {feed.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage && <Spinner />}
          Load more
        </Button>
      )}
    </>
  )
}
