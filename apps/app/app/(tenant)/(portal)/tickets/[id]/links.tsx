"use client"

import {
  LINK_KINDS_FROM,
  type LinkKind,
  type Ticket,
  type TicketLink,
  ticketLinkSchema,
  ticketSearchResultSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { StatusBadge } from "@/components/tickets/badges"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { LINK_KIND_LABEL } from "@/lib/labels"

/**
 * The tickets this one is linked to, each read from here (DOMAIN.md §1): an
 * incident is "caused by" the problem that "causes" it. Adding takes a kind
 * this type can start a link with and another ticket's number; the server
 * decides, follows a duplicate to its survivor, and refuses what does not
 * fit. "Raise a problem from this" and "raise a change for this" are the
 * shortcuts the console uses most.
 */
export function Links({
  ticket,
  links,
}: {
  ticket: Ticket
  links: TicketLink[]
}) {
  const { creatableTypes } = useTenant()
  const canLink = ticket.capabilities.canLink
  const raiseProblem =
    canLink && ticket.type === "INCIDENT" && creatableTypes.includes("PROBLEM")
  const raiseChange =
    canLink && ticket.type === "PROBLEM" && creatableTypes.includes("CHANGE")
  if (links.length === 0 && !canLink) return null

  return (
    <section className="min-w-0">
      <h2 className="text-sm font-semibold">Linked tickets</h2>
      {links.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 text-sm">
          {links.map((link) => (
            <LinkRow
              key={link.id}
              ticket={ticket}
              link={link}
              canLink={canLink}
            />
          ))}
        </ul>
      )}
      {canLink && <AddLink ticket={ticket} />}
      {(raiseProblem || raiseChange) && (
        <Button
          nativeButton={false}
          size="sm"
          variant="outline"
          className="mt-3"
          render={
            <Link
              href={
                raiseProblem
                  ? `/tickets/new?incident=${ticket.id}`
                  : `/tickets/new?problem=${ticket.id}`
              }
            />
          }
        >
          {raiseProblem
            ? "Raise a problem from this"
            : "Raise a change for this"}
        </Button>
      )}
    </section>
  )
}

function LinkRow({
  ticket,
  link,
  canLink,
}: {
  ticket: Ticket
  link: TicketLink
  canLink: boolean
}) {
  const router = useRouter()
  const remove = useMutation({
    mutationFn: () =>
      clientApi(`/tickets/${ticket.id}/links/${link.id}`, {
        method: "DELETE",
        schema: z.array(ticketLinkSchema),
      }),
    onSuccess: () => router.refresh(),
    onError: (error) =>
      toast.error(failureMessage(error, "The link wasn't removed.")),
  })
  return (
    <li className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {LINK_KIND_LABEL[link.kind]}
        </p>
        <Link
          href={`/tickets/${link.ticket.id}`}
          className="block truncate hover:underline"
        >
          <span className="font-mono text-xs tabular-nums">
            {link.ticket.number}
          </span>{" "}
          {link.ticket.title}
        </Link>
        <StatusBadge status={link.ticket.status} />
      </div>
      {canLink && (
        <button
          type="button"
          aria-label={`Remove the link to ${link.ticket.number}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className="text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </li>
  )
}

function AddLink({ ticket }: { ticket: Ticket }) {
  const router = useRouter()
  const kinds = LINK_KINDS_FROM[ticket.type]
  const [kind, setKind] = useState<LinkKind>(kinds[0] ?? "RELATES_TO")
  const [number, setNumber] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const add = useMutation({
    mutationFn: async () => {
      // A number is how people name tickets; the search resolves it inside their own scope.
      const found = await clientApi(
        `/tickets/search?q=${encodeURIComponent(number.trim())}&limit=1`,
        { schema: ticketSearchResultSchema }
      )
      const target = found.items.find(
        (t) => t.number.toLowerCase() === number.trim().toLowerCase()
      )
      if (target === undefined) throw new Error("not-found")
      return clientApi(`/tickets/${ticket.id}/links`, {
        method: "POST",
        body: { kind, ticketId: target.id },
        schema: z.array(ticketLinkSchema),
      })
    },
    onSuccess: () => {
      setNumber("")
      setProblem(null)
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof Error && error.message === "not-found")
        setProblem(`No ticket ${number.trim()} that you can see.`)
      else if (error instanceof ApiError && error.status < 500)
        setProblem(error.message)
      else toast.error(failureMessage(error, "The link wasn't added."))
    },
  })
  return (
    <form
      className="mt-3 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (number.trim() !== "") add.mutate()
      }}
    >
      <div className="grid gap-2">
        <label htmlFor="link-kind" className="sr-only">
          How they are linked
        </label>
        <NativeSelect
          id="link-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as LinkKind)}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {LINK_KIND_LABEL[k]}
            </option>
          ))}
        </NativeSelect>
        <label htmlFor="link-number" className="sr-only">
          Ticket number
        </label>
        <input
          id="link-number"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="INC-000042"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm"
        />
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={add.isPending || number.trim() === ""}
      >
        {add.isPending && <Spinner />}
        Link
      </Button>
    </form>
  )
}
