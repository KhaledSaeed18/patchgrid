"use client"

import {
  type Comment,
  commentSchema,
  type Member,
  type Team,
  type Ticket,
  type TicketAction,
  ticketSchema,
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
import { cn } from "@patchgrid/ui/lib/utils"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { Assignment } from "./assignment"
import { PriorityBadge, StatusBadge } from "@/components/tickets/badges"
import { DueBadge } from "@/components/tickets/due-badge"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import {
  IMPACT_LABEL,
  TICKET_ACTION_LABEL,
  TICKET_TYPE_LABEL,
  URGENCY_LABEL,
} from "@/lib/labels"

/**
 * Actions that take a note in the same request. `wait` and `resolve` always
 * need one; `cancel` does once work has started — the server says which, and
 * its 400 lands on the field. Assignment has its own control.
 */
const WITH_NOTE: Partial<Record<TicketAction, string>> = {
  wait: "What do you need from the requester?",
  resolve: "What was done to fix it?",
  cancel: "Why is it being cancelled?",
}
const PRIMARY: readonly TicketAction[] = ["start", "resolve", "close", "resume"]

export function TicketDetail({
  ticket,
  comments,
  assignable,
}: {
  ticket: Ticket
  comments: Comment[]
  /** Present when the actor may assign: the active agents and teams to choose from. */
  assignable: { agents: Member[]; teams: Team[] } | null
}) {
  const actions = ticket.availableActions.filter((a) => a !== "assign")
  return (
    <div className="px-6 py-8 md:px-10">
      <Link
        href={ticket.capabilities.canAssign ? "/queues" : "/tickets"}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {ticket.capabilities.canAssign ? "Queues" : "My tickets"}
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="font-mono text-xs tabular-nums">{ticket.number}</span>
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        {ticket.dueAt !== null && ticket.capabilities.canAssign && (
          <DueBadge
            dueAt={ticket.dueAt}
            breached={ticket.breached}
            paused={ticket.status === "PENDING"}
          />
        )}
      </div>
      <h1 className="mt-3 max-w-3xl font-serif text-2xl tracking-tight text-pretty">
        {ticket.title}
      </h1>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <main className="min-w-0">
          {actions.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              {actions.map((action) => (
                <TransitionButton
                  key={action}
                  ticket={ticket}
                  action={action}
                />
              ))}
            </div>
          )}
          <article className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted-foreground">
              {ticket.requester.displayName} raised this{" "}
              <RelativeTime at={ticket.createdAt} />
            </p>
            <p className="mt-2 text-sm whitespace-pre-wrap">
              {ticket.description}
            </p>
          </article>
          <Thread comments={comments} />
          {(ticket.capabilities.canCommentPublic ||
            ticket.capabilities.canCommentInternal) && (
            <Reply ticket={ticket} />
          )}
        </main>
        <aside className="grid content-start gap-8">
          {assignable !== null && (
            <Assignment
              key={ticket.version}
              ticket={ticket}
              agents={assignable.agents}
              teams={assignable.teams}
            />
          )}
          <dl className="grid gap-4 text-sm">
            <Fact label="Type">{TICKET_TYPE_LABEL[ticket.type]}</Fact>
            <Fact label="Requester">{ticket.requester.displayName}</Fact>
            {assignable === null && (
              <>
                <Fact label="Assignee">
                  {ticket.assignee?.displayName ?? "Nobody yet"}
                </Fact>
                <Fact label="Team">{ticket.team?.name ?? "Triage"}</Fact>
              </>
            )}
            <Fact label="Category">{ticket.category?.name ?? "None"}</Fact>
            <Fact label="Affects">{IMPACT_LABEL[ticket.impact]}</Fact>
            <Fact label="Urgency">{URGENCY_LABEL[ticket.urgency]}</Fact>
            {ticket.resolvedAt !== null && (
              <Fact label="Resolved">
                <RelativeTime at={ticket.resolvedAt} />
              </Fact>
            )}
          </dl>
        </aside>
      </div>
    </div>
  )
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function Thread({ comments }: { comments: Comment[] }) {
  if (comments.length === 0) return null
  return (
    <ol className="mt-6 grid gap-4">
      {comments.map((comment) => (
        <li
          key={comment.id}
          className={cn(
            "rounded-lg border p-4",
            comment.visibility === "INTERNAL"
              ? "border-dashed border-foreground/30 bg-foreground/[0.03]"
              : "border-border"
          )}
        >
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              {comment.author?.displayName ?? "Patchgrid"}
            </span>{" "}
            <RelativeTime at={comment.createdAt} />
            {comment.visibility === "INTERNAL" && " · internal note"}
            {comment.editedAt !== null && " · edited"}
          </p>
          {comment.body === null ? (
            <p className="mt-2 text-sm text-muted-foreground italic">
              This comment was removed.
            </p>
          ) : (
            <p className="mt-2 text-sm whitespace-pre-wrap">{comment.body}</p>
          )}
        </li>
      ))}
    </ol>
  )
}

function Reply({ ticket }: { ticket: Ticket }) {
  const router = useRouter()
  const { canCommentPublic, canCommentInternal } = ticket.capabilities
  const [body, setBody] = useState("")
  const send = useMutation({
    mutationFn: (visibility: "PUBLIC" | "INTERNAL") =>
      clientApi(`/tickets/${ticket.id}/comments`, {
        method: "POST",
        body: { body: body.trim(), visibility },
        schema: commentSchema,
      }),
    onSuccess: () => {
      setBody("")
      router.refresh()
    },
    onError: (error) =>
      toast.error(failureMessage(error, "Your reply wasn't sent.")),
  })
  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (body.trim() !== "")
          send.mutate(canCommentPublic ? "PUBLIC" : "INTERNAL")
      }}
    >
      <label htmlFor="reply" className="sr-only">
        Reply
      </label>
      <Textarea
        id="reply"
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={
          canCommentInternal
            ? "Reply to the requester, or add a note only agents see"
            : "Add a reply"
        }
      />
      <div className="mt-2 flex gap-2">
        {canCommentPublic && (
          <Button type="submit" disabled={send.isPending || body.trim() === ""}>
            {send.isPending && send.variables === "PUBLIC" && <Spinner />}
            Send reply
          </Button>
        )}
        {canCommentInternal && (
          <Button
            type="button"
            variant="outline"
            disabled={send.isPending || body.trim() === ""}
            onClick={() => send.mutate("INTERNAL")}
          >
            {send.isPending && send.variables === "INTERNAL" && <Spinner />}
            Add internal note
          </Button>
        )}
      </div>
    </form>
  )
}

function TransitionButton({
  ticket,
  action,
}: {
  ticket: Ticket
  action: TicketAction
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const prompt = WITH_NOTE[action]
  const run = useMutation({
    mutationFn: (comment: string) =>
      clientApi(`/tickets/${ticket.id}/transitions`, {
        method: "POST",
        body: {
          action,
          version: ticket.version,
          ...(comment === ""
            ? {}
            : { comment: { body: comment, visibility: "PUBLIC" } }),
        },
        schema: ticketSchema,
      }),
    onSuccess: () => {
      setOpen(false)
      setNote("")
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.type === "stale-write") {
        toast.error("Someone else changed this ticket. It has been reloaded.")
        router.refresh()
        setOpen(false)
      } else if (!(error instanceof ApiError && error.status === 400)) {
        toast.error(failureMessage(error, "That didn't go through."))
      }
    },
  })
  const noteError =
    run.error instanceof ApiError
      ? (run.error.fieldError("comment") ??
        run.error.fieldError("comment.body"))
      : undefined
  const variant = PRIMARY.includes(action) ? "default" : "outline"

  if (prompt === undefined) {
    return (
      <Button
        variant={variant}
        disabled={run.isPending}
        onClick={() => run.mutate("")}
      >
        {run.isPending && <Spinner />}
        {TICKET_ACTION_LABEL[action]}
      </Button>
    )
  }
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {TICKET_ACTION_LABEL[action]}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{TICKET_ACTION_LABEL[action]}</DialogTitle>
            <DialogDescription>
              {prompt} The note is added to the conversation, where the
              requester can read it.
            </DialogDescription>
          </DialogHeader>
          <form
            id={`transition-${action}`}
            onSubmit={(event) => {
              event.preventDefault()
              run.mutate(note.trim())
            }}
          >
            <label htmlFor={`note-${action}`} className="sr-only">
              Note
            </label>
            <Textarea
              id={`note-${action}`}
              rows={4}
              value={note}
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={noteError !== undefined ? true : undefined}
            />
            {noteError !== undefined && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {noteError}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button
              type="submit"
              form={`transition-${action}`}
              disabled={run.isPending}
            >
              {run.isPending && <Spinner />}
              {TICKET_ACTION_LABEL[action]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
