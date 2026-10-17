"use client"

import {
  type BulkOutcome,
  type BulkTicketRequest,
  type BulkTicketResult,
  bulkTicketResultSchema,
  MAX_BULK_TICKETS,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { useLiveEvent } from "@/components/live-provider"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { newUuid } from "@/lib/idempotency"

type Picked = { id: string; version: number; number: string }

/** The moves offered in bulk; those that need a reason ask for it, as the single action would. */
const MOVES = [
  { label: "Assign to me", action: null, needsComment: false },
  { label: "Start", action: "start", needsComment: false },
  { label: "Resolve…", action: "resolve", needsComment: true },
  { label: "Close", action: "close", needsComment: false },
  { label: "Cancel…", action: "cancel", needsComment: true },
] as const
type Move = (typeof MOVES)[number]

const OUTCOME_LABEL: Record<Exclude<BulkOutcome, "done">, string> = {
  conflict: "Changed by someone else since it was loaded",
  refused: "Refused",
  "not-found": "Not found",
}

/**
 * Acts on the picked tickets at once (ADR-0052). Each ticket is decided as the
 * single action would decide it; the bar shows progress from the live stream
 * while the request runs, then every ticket that did not go through, and why.
 */
export function BulkBar({
  picked,
  onChanged,
  onFinished,
}: {
  picked: Picked[]
  /** Something changed: the list refetches. */
  onChanged: () => void
  /** The agent is done with this selection: it clears, and the bar goes. Not before the results are read. */
  onFinished: () => void
}) {
  const tenant = useTenant()
  const router = useRouter()
  const [asking, setAsking] = useState<Move | null>(null)
  const [comment, setComment] = useState("")
  const [operationId, setOperationId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<BulkTicketResult | null>(null)

  useLiveEvent("bulk-progress", (event) => {
    if (event.operationId === operationId) setProgress(event.processed)
  })

  const run = useMutation({
    mutationFn: (move: { action: Move["action"]; comment: string | null }) => {
      const id = newUuid()
      setOperationId(id)
      setProgress(0)
      const action: BulkTicketRequest["action"] =
        move.action === null
          ? { kind: "assign", assigneeMembershipId: tenant.membership.id }
          : {
              kind: "transition",
              action: move.action,
              ...(move.comment === null ? {} : { comment: { body: move.comment, visibility: "PUBLIC" as const } }),
            }
      return clientApi("/tickets/bulk", {
        method: "POST",
        body: { operationId: id, tickets: picked.map(({ id: ticketId, version }) => ({ id: ticketId, version })), action },
        schema: bulkTicketResultSchema,
      })
    },
    onSuccess: (answer) => {
      setAsking(null)
      setComment("")
      setOperationId(null)
      onChanged()
      router.refresh()
      if (answer.done === answer.total) {
        toast.success(`Done for all ${String(answer.total)}.`)
        onFinished()
      } else {
        setResult(answer)
      }
    },
    onError: (error) => {
      setOperationId(null)
      toast.error(failureMessage(error, "Nothing was changed."))
    },
  })

  const tooMany = picked.length > MAX_BULK_TICKETS
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="text-sm font-medium">{picked.length} selected</span>
      {tooMany ? (
        <span className="text-sm text-muted-foreground">At most {MAX_BULK_TICKETS} at once.</span>
      ) : run.isPending ? (
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Spinner />
          <div className="h-2 w-40 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-chart-3 transition-[width]" style={{ width: `${String((progress / picked.length) * 100)}%` }} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {progress} of {picked.length}
          </span>
        </div>
      ) : (
        MOVES.map((move) => (
          <Button
            key={move.label}
            variant="outline"
            size="sm"
            onClick={() => (move.needsComment ? setAsking(move) : run.mutate({ action: move.action, comment: null }))}
          >
            {move.label}
          </Button>
        ))
      )}

      <Dialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {asking?.label.replace("…", "")} {picked.length} tickets
            </DialogTitle>
            <DialogDescription>
              This reply is posted publicly on each ticket, as it would be on one.
            </DialogDescription>
          </DialogHeader>
          <Textarea aria-label="Reply" value={comment} rows={4} onChange={(e) => setComment(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>
              Back
            </Button>
            <Button
              disabled={comment.trim() === "" || run.isPending}
              onClick={() => asking !== null && run.mutate({ action: asking.action, comment: comment.trim() })}
            >
              {run.isPending && <Spinner />}
              {asking?.label.replace("…", "")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={result !== null}
        onOpenChange={(open) => {
          if (open) return
          setResult(null)
          onFinished()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {result?.done ?? 0} of {result?.total ?? 0} done
            </DialogTitle>
            <DialogDescription>The rest were left as they were, each for its own reason.</DialogDescription>
          </DialogHeader>
          <ul className="grid max-h-80 gap-2 overflow-y-auto text-sm">
            {result?.results
              .filter((r) => r.outcome !== "done")
              .map((r) => (
                <li key={r.ticketId} className="rounded-md border border-border px-3 py-2">
                  <a href={`/tickets/${r.ticketId}`} className="font-mono text-xs hover:underline">
                    {picked.find((p) => p.id === r.ticketId)?.number ?? "Ticket"}
                  </a>
                  <p>{r.outcome === "done" ? "" : OUTCOME_LABEL[r.outcome]}</p>
                  {r.detail !== null && <p className="text-xs text-muted-foreground">{r.detail}</p>}
                </li>
              ))}
          </ul>
          <DialogFooter>
            <Button
              onClick={() => {
                setResult(null)
                onFinished()
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
