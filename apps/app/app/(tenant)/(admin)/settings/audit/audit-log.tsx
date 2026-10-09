"use client"

import {
  type AuditAction,
  auditActionSchema,
  type AuditPage,
  auditPageSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useState } from "react"

import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { ACTION_NAMES, describe } from "@/lib/audit-text"

export function AuditLog({
  first,
  members,
}: {
  first: AuditPage
  members: { id: string; name: string }[]
}) {
  const [action, setAction] = useState<AuditAction | "">("")
  const [actor, setActor] = useState("")
  const unfiltered = action === "" && actor === ""
  const names = (id: string) => members.find((m) => m.id === id)?.name

  const log = useInfiniteQuery({
    queryKey: ["audit", action, actor],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" })
      if (action !== "") query.set("action", action)
      if (actor !== "") query.set("actorMembershipId", actor)
      if (pageParam !== null) query.set("cursor", pageParam)
      return clientApi(`/org/audit?${query.toString()}`, {
        schema: auditPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    ...(unfiltered
      ? { initialData: { pages: [first], pageParams: [null] } }
      : {}),
  })
  const entries = log.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="px-6 py-6 md:px-10">
      <div className="flex flex-wrap gap-3">
        <NativeSelect
          aria-label="Filter by change"
          className="w-60"
          value={action}
          onChange={(e) => setAction(e.target.value as AuditAction | "")}
        >
          <option value="">Every kind of change</option>
          {auditActionSchema.options.map((a) => (
            <option key={a} value={a}>
              {ACTION_NAMES[a].charAt(0).toUpperCase() +
                ACTION_NAMES[a].slice(1)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by person"
          className="w-52"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          <option value="">Everyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </NativeSelect>
      </div>

      {log.isPending ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {unfiltered
            ? "Nothing has changed yet. Invitations, role changes and settings edits will appear here."
            : "No changes match these filters."}
        </p>
      ) : (
        <ol className="mt-6 divide-y divide-border border-y border-border">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 text-sm"
            >
              <span>{describe(entry, names)}</span>
              <time
                dateTime={entry.createdAt}
                className="text-xs text-muted-foreground tabular-nums"
              >
                {new Date(entry.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </li>
          ))}
        </ol>
      )}

      {log.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage && <Spinner />}
          Show older changes
        </Button>
      )}
    </div>
  )
}
