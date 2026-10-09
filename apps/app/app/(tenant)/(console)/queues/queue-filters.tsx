"use client"

import {
  type TicketSort,
  ticketSortSchema,
  type TicketStatus,
  ticketStatusSchema,
  type TicketView,
} from "@patchgrid/contracts"
import { Input } from "@patchgrid/ui/components/input"
import { useRouter } from "next/navigation"

import { NativeSelect } from "@/components/native-select"
import { TICKET_STATUS_LABEL } from "@/lib/labels"

/** The statuses an incident queue can hold; Problem and Change states arrive with M4. */
const STATUSES: TicketStatus[] = [
  "NEW",
  "ASSIGNED",
  "IN_PROGRESS",
  "PENDING",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
]

/** Search, status and order, written to the URL; the server page reads them back. */
export function QueueFilters({
  view,
  status,
  sort,
  q,
}: {
  view: TicketView
  status: TicketStatus | undefined
  sort: TicketSort
  q: string
}) {
  const router = useRouter()
  const go = (next: {
    status?: TicketStatus | undefined
    sort?: TicketSort
    q?: string
  }) => {
    const params = new URLSearchParams({ view })
    const s = "status" in next ? next.status : status
    if (s !== undefined) params.set("status", s)
    const order = next.sort ?? sort
    if (order !== "newest") params.set("sort", order)
    const text = next.q ?? ""
    if (text !== "") params.set("q", text)
    router.push(`/queues?${params.toString()}`)
  }
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      <form
        role="search"
        className="w-full max-w-sm"
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          go({ q: String(data.get("q") ?? "").trim() })
        }}
      >
        <Input
          key={q}
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search titles, descriptions or INC-42"
          aria-label="Search tickets"
        />
      </form>
      {q === "" && (
        <NativeSelect
          aria-label="Status"
          className="w-48"
          value={status ?? ""}
          onChange={(e) => {
            const parsed = ticketStatusSchema.safeParse(e.target.value)
            go({ status: parsed.success ? parsed.data : undefined })
          }}
        >
          <option value="">Any open status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      )}
      {q === "" && (
        <NativeSelect
          aria-label="Order"
          className="w-40"
          value={sort}
          onChange={(e) => {
            const parsed = ticketSortSchema.safeParse(e.target.value)
            if (parsed.success) go({ sort: parsed.data })
          }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </NativeSelect>
      )}
    </div>
  )
}
