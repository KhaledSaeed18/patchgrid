"use client"

import { type Comment, commentSchema } from "@patchgrid/contracts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@patchgrid/ui/components/alert-dialog"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { cn } from "@patchgrid/ui/lib/utils"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"

/**
 * One comment in the thread. "Edit" and "Delete" appear only when the server
 * marked this comment `canEdit` / `canDelete` for this actor — the author
 * within the edit window, admins for removal — and the API enforces both
 * again. A removed comment keeps its place and says so, without its words.
 */
export function CommentItem({
  ticketId,
  comment,
}: {
  ticketId: string
  comment: Comment
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [confirming, setConfirming] = useState(false)
  const removed = comment.body === null

  const save = useMutation({
    mutationFn: (body: string) =>
      clientApi(`/tickets/${ticketId}/comments/${comment.id}`, {
        method: "PATCH",
        body: { body },
        schema: commentSchema,
      }),
    onSuccess: () => {
      setEditing(false)
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 400) return
      // The edit window closed or the comment changed under us: what the page shows is stale.
      if (error instanceof ApiError && [403, 404, 409].includes(error.status))
        router.refresh()
      toast.error(failureMessage(error, "Your edit wasn't saved."))
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      clientApi(`/tickets/${ticketId}/comments/${comment.id}`, {
        method: "DELETE",
        schema: null,
      }),
    onSuccess: () => {
      setConfirming(false)
      router.refresh()
    },
    onError: (error) => {
      setConfirming(false)
      if (error instanceof ApiError && [403, 404, 409].includes(error.status))
        router.refresh()
      toast.error(failureMessage(error, "The comment wasn't removed."))
    },
  })
  const bodyError =
    save.error instanceof ApiError ? save.error.fieldError("body") : undefined

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        comment.visibility === "INTERNAL"
          ? "border-dashed border-foreground/30 bg-foreground/[0.03]"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {comment.author?.displayName ?? "Patchgrid"}
          </span>{" "}
          <RelativeTime at={comment.createdAt} />
          {comment.visibility === "INTERNAL" && " · internal note"}
          {!removed && comment.editedAt !== null && " · edited"}
        </p>
        {!editing && !removed && (comment.canEdit || comment.canDelete) && (
          <div className="flex shrink-0 gap-1">
            {comment.canEdit && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setDraft(comment.body ?? "")
                  setEditing(true)
                }}
              >
                Edit
              </Button>
            )}
            {comment.canDelete && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
      {removed ? (
        <p className="mt-2 text-sm text-muted-foreground italic">
          This comment was removed.
        </p>
      ) : editing ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim() !== "") save.mutate(draft.trim())
          }}
        >
          <label htmlFor={`edit-${comment.id}`} className="sr-only">
            Edit comment
          </label>
          <Textarea
            id={`edit-${comment.id}`}
            rows={4}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={bodyError !== undefined ? true : undefined}
          />
          {bodyError !== undefined && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {bodyError}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={save.isPending || draft.trim() === ""}
            >
              {save.isPending && <Spinner />}
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                save.reset()
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2 text-sm whitespace-pre-wrap">{comment.body}</p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this comment?</AlertDialogTitle>
            <AlertDialogDescription>
              Its text is deleted for everyone. The thread keeps a line saying a
              comment was removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Spinner />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
