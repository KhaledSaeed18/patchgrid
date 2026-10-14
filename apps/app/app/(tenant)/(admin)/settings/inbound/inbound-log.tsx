"use client"

import {
  type InboundEmailPage,
  inboundEmailPageSchema,
  type InboundOutcome,
  inboundOutcomeSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { cn } from "@patchgrid/ui/lib/utils"
import { useInfiniteQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"

import { NativeSelect } from "@/components/native-select"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { AUTH_VERDICT_LABEL, INBOUND_OUTCOME_LABEL } from "@/lib/labels"

const TAKEN: ReadonlySet<InboundOutcome> = new Set(["CREATED", "THREADED"])

/** The inbound log (ADR-0027): every message that reached the workspace, its verdict and its fate. */
export function InboundLog({ first }: { first: InboundEmailPage }) {
  const [outcome, setOutcome] = useState<InboundOutcome | "">("")
  const log = useInfiniteQuery({
    queryKey: ["inbound", outcome],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" })
      if (outcome !== "") query.set("outcome", outcome)
      if (pageParam !== null) query.set("cursor", pageParam)
      return clientApi(`/org/inbound-emails?${query.toString()}`, {
        schema: inboundEmailPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    ...(outcome === ""
      ? { initialData: { pages: [first], pageParams: [null] } }
      : {}),
  })
  const rows = log.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="px-6 py-6 md:px-10">
      <NativeSelect
        aria-label="What became of it"
        className="w-56"
        value={outcome}
        onChange={(e) => {
          const parsed = inboundOutcomeSchema.safeParse(e.target.value)
          setOutcome(parsed.success ? parsed.data : "")
        }}
      >
        <option value="">Every message</option>
        {inboundOutcomeSchema.options.map((o) => (
          <option key={o} value={o}>
            {INBOUND_OUTCOME_LABEL[o]}
          </option>
        ))}
      </NativeSelect>
      {log.isPending ? (
        <Spinner className="mt-6" />
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {outcome === ""
            ? "No mail has arrived yet."
            : "No messages like that."}
        </p>
      ) : (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>From</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Sender check</TableHead>
              <TableHead>What became of it</TableHead>
              <TableHead className="text-right">Received</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="max-w-56">
                  <p className="truncate">
                    {row.sender?.displayName ?? row.fromAddress}
                  </p>
                  {row.sender !== null && (
                    <p className="truncate text-xs text-muted-foreground">
                      {row.fromAddress}
                    </p>
                  )}
                </TableCell>
                <TableCell className="max-w-xs">
                  <p className="truncate">
                    {row.subject === "" ? "(no subject)" : row.subject}
                  </p>
                  {row.skippedAttachments.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Left out:{" "}
                      {row.skippedAttachments
                        .map((f) => `${f.filename} (${f.reason})`)
                        .join(", ")}
                    </p>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-xs",
                    row.authVerdict === "PASS"
                      ? "text-muted-foreground"
                      : "text-destructive"
                  )}
                >
                  {AUTH_VERDICT_LABEL[row.authVerdict]}
                </TableCell>
                <TableCell className="text-sm">
                  {row.ticket !== null ? (
                    <Link
                      href={`/tickets/${row.ticket.id}`}
                      className="hover:underline"
                    >
                      {INBOUND_OUTCOME_LABEL[row.outcome]}{" "}
                      <span className="font-mono text-xs tabular-nums">
                        {row.ticket.number}
                      </span>
                    </Link>
                  ) : (
                    <span
                      className={
                        TAKEN.has(row.outcome)
                          ? undefined
                          : "text-muted-foreground"
                      }
                    >
                      {INBOUND_OUTCOME_LABEL[row.outcome]}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <RelativeTime at={row.receivedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {log.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage && <Spinner />}
          Show more
        </Button>
      )}
    </div>
  )
}
