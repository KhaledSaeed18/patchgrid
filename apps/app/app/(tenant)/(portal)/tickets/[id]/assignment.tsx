"use client"

import {
  type Member,
  type Team,
  type Ticket,
  ticketSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"

/**
 * Team and assignee, changed together in one versioned write. Offered only
 * when the server's `capabilities.canAssign` says so; the candidate lists are
 * active agents and active teams — the API refuses anyone else anyway.
 */
export function Assignment({
  ticket,
  agents,
  teams,
}: {
  ticket: Ticket
  agents: Member[]
  teams: Team[]
}) {
  const router = useRouter()
  const { membership } = useTenant()
  const [teamId, setTeamId] = useState(ticket.team?.id ?? "")
  const [assigneeId, setAssigneeId] = useState(
    ticket.assignee?.membershipId ?? ""
  )
  const changed =
    teamId !== (ticket.team?.id ?? "") ||
    assigneeId !== (ticket.assignee?.membershipId ?? "")
  const save = useMutation({
    mutationFn: (next: { teamId: string; assigneeId: string }) =>
      clientApi(`/tickets/${ticket.id}/assignment`, {
        method: "PUT",
        body: {
          version: ticket.version,
          teamId: next.teamId === "" ? null : next.teamId,
          assigneeMembershipId: next.assigneeId === "" ? null : next.assigneeId,
        },
        schema: ticketSchema,
      }),
    onSuccess: () => {
      toast.success("Assignment saved")
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.type === "stale-write") {
        toast.error("Someone else changed this ticket. It has been reloaded.")
        router.refresh()
      } else {
        toast.error(failureMessage(error, "The assignment wasn't saved."))
      }
    },
  })
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate({ teamId, assigneeId })
      }}
    >
      <div className="grid gap-1">
        <label htmlFor="assign-team" className="text-sm text-muted-foreground">
          Team
        </label>
        <NativeSelect
          id="assign-team"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">Triage</option>
          {teams
            .filter((t) => t.isActive || t.id === ticket.team?.id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <label htmlFor="assign-agent" className="text-sm text-muted-foreground">
          Assignee
        </label>
        <NativeSelect
          id="assign-agent"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
        >
          <option value="">Nobody</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id === membership.id
                ? `${a.displayName} (you)`
                : a.displayName}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!changed || save.isPending}>
          {save.isPending && <Spinner />}
          Save assignment
        </Button>
        {assigneeId !== membership.id && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => {
              setAssigneeId(membership.id)
              save.mutate({ teamId, assigneeId: membership.id })
            }}
          >
            Take it
          </Button>
        )}
      </div>
    </form>
  )
}
