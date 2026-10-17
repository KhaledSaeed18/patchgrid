"use client"

import {
  type Priority,
  prioritySchema,
  TICKET_STATUSES_BY_TYPE,
  type TicketSort,
  ticketSortSchema,
  type TicketStatus,
  ticketStatusSchema,
  type TicketType,
  ticketTypeSchema,
  type TicketView,
} from "@patchgrid/contracts"
import { Input } from "@patchgrid/ui/components/input"
import { useRouter } from "next/navigation"

import { NativeSelect } from "@/components/native-select"
import { PRIORITY_LABEL, TICKET_STATUS_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels"

/** Every status, in the order the types' lifecycles first meet them. */
const ALL_STATUSES: TicketStatus[] = [
  ...new Set(Object.values(TICKET_STATUSES_BY_TYPE).flat()),
]

/** Search, type, status and order, written to the URL; the server page reads them back. */
export function QueueFilters({
  view,
  type,
  status,
  priority,
  sort,
  q,
}: {
  view: TicketView
  type: TicketType | undefined
  status: TicketStatus | undefined
  priority: Priority | undefined
  sort: TicketSort
  q: string
}) {
  const router = useRouter()
  const statuses =
    type === undefined ? ALL_STATUSES : TICKET_STATUSES_BY_TYPE[type]
  const go = (next: {
    type?: TicketType | undefined
    status?: TicketStatus | undefined
    priority?: Priority | undefined
    sort?: TicketSort
    q?: string
  }) => {
    const params = new URLSearchParams({ view })
    const t = "type" in next ? next.type : type
    if (t !== undefined) params.set("type", t)
    const s = "status" in next ? next.status : status
    if (s !== undefined) params.set("status", s)
    const p = "priority" in next ? next.priority : priority
    if (p !== undefined) params.set("priority", p)
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
      {q === "" && view !== "approvals" && (
        <NativeSelect
          aria-label="Type"
          className="w-44"
          value={type ?? ""}
          onChange={(e) => {
            const parsed = ticketTypeSchema.safeParse(e.target.value)
            const nextType = parsed.success ? parsed.data : undefined
            // A status the new type never has would only empty the list.
            const keep =
              status !== undefined &&
              (nextType === undefined ||
                TICKET_STATUSES_BY_TYPE[nextType].includes(status))
            go({ type: nextType, status: keep ? status : undefined })
          }}
        >
          <option value="">Every type</option>
          {ticketTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {TICKET_TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
      )}
      {q === "" && view !== "approvals" && (
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
          {statuses.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      )}
      {q === "" && view !== "approvals" && (
        <NativeSelect
          aria-label="Priority"
          className="w-40"
          value={priority ?? ""}
          onChange={(e) => {
            const parsed = prioritySchema.safeParse(e.target.value)
            go({ priority: parsed.success ? parsed.data : undefined })
          }}
        >
          <option value="">Any priority</option>
          {prioritySchema.options.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
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
