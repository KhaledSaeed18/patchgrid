"use client"

import { Notification01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { notificationPageSchema } from "@patchgrid/contracts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@patchgrid/ui/components/dropdown-menu"
import { cn } from "@patchgrid/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { notificationHref } from "@/lib/notification-link"

import { useMarkAllRead, useMarkRead } from "./mutations"

/**
 * The inbox at a glance: an unread count on a button, the ten latest behind
 * it. The count is the server's, kept fresh by the live stream. Opening a
 * notification marks it read and goes to its ticket.
 */
export function NotificationBell({
  side,
  align,
}: {
  side: "top" | "bottom"
  align: "start" | "end"
}) {
  const router = useRouter()
  const markRead = useMarkRead()
  const markAll = useMarkAllRead()
  const inbox = useQuery({
    queryKey: ["notifications", "bell"],
    queryFn: () =>
      clientApi("/notifications?limit=10", { schema: notificationPageSchema }),
  })
  const unread = inbox.data?.unreadCount ?? 0
  const items = inbox.data?.items ?? []

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          unread === 0 ? "Notifications" : `Notifications, ${unread} unread`
        }
        className="relative flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <HugeiconsIcon icon={Notification01Icon} className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.65rem] font-medium text-primary-foreground tabular-nums"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-80">
        <div className="flex items-center justify-between px-1.5 py-1">
          <p className="text-xs font-medium text-muted-foreground">
            Notifications
          </p>
          {unread > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="px-1.5 py-4 text-center text-sm text-muted-foreground">
            {inbox.isPending ? "Loading…" : "You're all caught up."}
          </p>
        ) : (
          items.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="items-start gap-2 py-1.5"
              onClick={() => {
                if (n.readAt === null) markRead.mutate(n.id)
                const href = notificationHref(n)
                if (href !== null) router.push(href)
              }}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  n.readAt === null ? "bg-primary" : "bg-transparent"
                )}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate",
                    n.readAt === null ? "font-medium" : "text-muted-foreground"
                  )}
                >
                  {n.title}
                  {n.count > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ×{n.count}
                    </span>
                  )}
                </span>
                <RelativeTime
                  at={n.updatedAt}
                  className="block text-xs text-muted-foreground"
                />
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/notifications" />}>
          View all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
