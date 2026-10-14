"use client"

import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  type Member,
  type Ticket,
  type Watcher,
  watcherSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

/**
 * Who is told about this ticket. The requester and the assignee always are,
 * without a row, and cannot be removed. The rest are explicit: a member may
 * add or remove themselves when the server's `capabilities.canWatch` says so,
 * and others when `canAddWatcher` does. The answer to every change is the new
 * list; the page refreshes to show it.
 */
export function Watchers({
  ticket,
  watchers,
  candidates,
}: {
  ticket: Ticket
  watchers: Watcher[]
  /** Active members who could be added; present when the actor may add others. */
  candidates: Member[] | null
}) {
  const router = useRouter()
  const { membership } = useTenant()
  const { canWatch, canAddWatcher } = ticket.capabilities
  const [pick, setPick] = useState("")
  const change = useMutation({
    mutationFn: ({
      membershipId,
      method,
    }: {
      membershipId: string
      method: "PUT" | "DELETE"
    }) =>
      clientApi(`/tickets/${ticket.id}/watchers/${membershipId}`, {
        method,
        schema: z.array(watcherSchema),
      }),
    onSuccess: () => {
      setPick("")
      router.refresh()
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The watchers weren't changed.")),
  })
  const watching = watchers.find((w) => w.membershipId === membership.id)
  const addable = (candidates ?? []).filter(
    (m) => !watchers.some((w) => w.membershipId === m.id)
  )
  const mayRemove = (w: Watcher) =>
    !w.implicit && (w.membershipId === membership.id ? canWatch : canAddWatcher)

  return (
    <section aria-labelledby="watchers-heading" className="grid gap-3 text-sm">
      <h2 id="watchers-heading" className="text-muted-foreground">
        Watchers
      </h2>
      <ul className="grid gap-1.5">
        {watchers.map((w) => (
          <li key={w.membershipId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {w.displayName}
              {w.membershipId === membership.id && " (you)"}
              {w.implicit && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  always watching
                </span>
              )}
            </span>
            {mayRemove(w) && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${w.displayName} as a watcher`}
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({
                    membershipId: w.membershipId,
                    method: "DELETE",
                  })
                }
              >
                <HugeiconsIcon icon={Cancel01Icon} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canWatch && watching === undefined && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={change.isPending}
          onClick={() =>
            change.mutate({ membershipId: membership.id, method: "PUT" })
          }
        >
          {change.isPending && <Spinner />}
          Watch
        </Button>
      )}
      {canWatch && watching !== undefined && !watching.implicit && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={change.isPending}
          onClick={() =>
            change.mutate({ membershipId: membership.id, method: "DELETE" })
          }
        >
          Stop watching
        </Button>
      )}
      {canAddWatcher && addable.length > 0 && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (pick !== "")
              change.mutate({ membershipId: pick, method: "PUT" })
          }}
        >
          <label htmlFor="add-watcher" className="sr-only">
            Add a watcher
          </label>
          <NativeSelect
            id="add-watcher"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Add a watcher…</option>
            {addable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pick === "" || change.isPending}
          >
            Add
          </Button>
        </form>
      )}
    </section>
  )
}
