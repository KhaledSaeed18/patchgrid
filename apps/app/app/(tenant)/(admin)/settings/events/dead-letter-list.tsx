"use client"

import { type DeadLetter, deadLetterSchema } from "@patchgrid/contracts"
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
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { EVENT_CONSUMER_LABEL } from "@/lib/labels"

/** What the event log's readers gave up on (ADR-0049), waiting ones first, each replayable once. */
export function DeadLetterList({ initial }: { initial: DeadLetter[] }) {
  if (initial.length === 0) {
    return (
      <p className="px-6 py-6 text-sm text-muted-foreground md:px-10">
        Nothing has been set aside. Every event has reached notifications,
        webhooks and reports.
      </p>
    )
  }
  return (
    <div className="px-6 py-6 md:px-10">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>For</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Why it was set aside</TableHead>
            <TableHead>Set aside</TableHead>
            <TableHead className="text-right">Replay</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {initial.map((letter) => (
            <Row key={letter.id} letter={letter} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Row({ letter }: { letter: DeadLetter }) {
  const router = useRouter()
  const replay = useMutation({
    mutationFn: () =>
      clientApi(`/org/events/dead-letters/${letter.id}/replay`, {
        method: "POST",
        body: {},
        schema: deadLetterSchema,
      }),
    onSuccess: () => {
      toast.success("Replayed")
      router.refresh()
    },
    onError: (error) => {
      toast.error(failureMessage(error, "The event could not be replayed"))
      // A failed replay updates the reason shown beside it.
      router.refresh()
    },
  })
  const done = letter.replayedAt !== null

  return (
    <TableRow className={done ? "opacity-60" : undefined}>
      <TableCell>{EVENT_CONSUMER_LABEL[letter.consumer]}</TableCell>
      <TableCell>
        <p className="font-mono text-xs">{letter.eventType}</p>
        <p className="text-xs text-muted-foreground">
          Happened <RelativeTime at={letter.occurredAt} />
        </p>
      </TableCell>
      <TableCell className="max-w-md whitespace-normal">
        <p
          className="line-clamp-3 font-mono text-xs break-words"
          title={letter.error}
        >
          {letter.error}
        </p>
        <p className="text-xs text-muted-foreground">
          Failed {letter.failures} {letter.failures === 1 ? "time" : "times"}
        </p>
      </TableCell>
      <TableCell className="text-muted-foreground">
        <RelativeTime at={letter.parkedAt} />
      </TableCell>
      <TableCell className="text-right">
        {done ? (
          <span className="text-xs text-muted-foreground">
            Replayed <RelativeTime at={letter.replayedAt ?? letter.parkedAt} />
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={replay.isPending}
            onClick={() => replay.mutate()}
          >
            {replay.isPending && <Spinner />}
            Replay
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}
