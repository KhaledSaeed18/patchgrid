"use client"

import {
  type Invitation,
  invitationSchema,
  type Member,
  type MemberPage,
  memberPageSchema,
  memberSchema,
  type Role,
  type Team,
} from "@patchgrid/contracts"
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
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@patchgrid/ui/components/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { ROLE_LABEL, STATUS_LABEL } from "@/lib/labels"

import { InviteDialog } from "./invite-dialog"

const ROLES: Role[] = ["REQUESTER", "AGENT", "ADMIN", "OWNER"]

export function MembersAdmin({
  initialMembers,
  initialInvitations,
  teams,
}: {
  initialMembers: MemberPage
  initialInvitations: Invitation[]
  teams: Team[]
}) {
  const { holds, membership } = useTenant()
  const queryClient = useQueryClient()
  const [showRemoved, setShowRemoved] = useState(false)

  const members = useQuery({
    queryKey: ["members", showRemoved],
    queryFn: () =>
      clientApi(`/members?limit=100&includeRemoved=${String(showRemoved)}`, {
        schema: memberPageSchema,
      }),
    ...(showRemoved ? {} : { initialData: initialMembers }),
  })
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () =>
      clientApi("/invitations", { schema: z.array(invitationSchema) }),
    initialData: initialInvitations,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members"] })

  const act = useMutation({
    mutationFn: (
      action:
        | { member: Member; kind: "role"; role: Role }
        | { member: Member; kind: "disable" | "enable" | "remove" }
    ) => {
      const path = `/members/${action.member.id}`
      switch (action.kind) {
        case "role":
          return clientApi(`${path}/role`, {
            method: "PATCH",
            body: { role: action.role },
            schema: memberSchema,
          })
        case "disable":
        case "enable":
          return clientApi(`${path}/${action.kind}`, {
            method: "POST",
            schema: memberSchema,
          })
        case "remove":
          return clientApi(path, { method: "DELETE", schema: null })
      }
    },
    onSuccess: (_result, action) => {
      toast.success(
        action.kind === "role"
          ? `${action.member.displayName} is now ${ROLE_LABEL[action.role].toLowerCase()}`
          : `${action.member.displayName} ${action.kind === "remove" ? "removed" : `${action.kind}d`}`
      )
      void refresh()
    },
    onError: (error) => {
      toast.error(failureMessage(error, "That change didn't go through."))
      void refresh()
    },
  })
  const [removing, setRemoving] = useState<Member | null>(null)

  const assignable = ROLES.filter(
    (r) => holds("member:promote_admin") || r === "REQUESTER" || r === "AGENT"
  )

  return (
    <div className="px-6 py-6 md:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
          Show removed members
        </label>
        {holds("member:invite") && (
          <InviteDialog
            teams={teams.filter((t) => t.isActive)}
            roles={assignable}
          />
        )}
      </div>

      {invitations.data.length > 0 && (
        <PendingInvitations invitations={invitations.data} />
      )}

      <Table className="mt-6">
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Teams</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(members.data?.items ?? []).map((member) => {
            const self = member.id === membership.id
            const editable = !self && member.status !== "REMOVED"
            return (
              <TableRow
                key={member.id}
                className={
                  member.status === "REMOVED" ? "opacity-60" : undefined
                }
              >
                <TableCell>
                  <p className="font-medium">
                    {member.displayName}
                    {self && (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </p>
                  {member.contact?.email !== undefined &&
                    member.contact.email !== null && (
                      <p className="text-xs text-muted-foreground">
                        {member.contact.email}
                      </p>
                    )}
                </TableCell>
                <TableCell>
                  {editable && holds("member:update_role") ? (
                    <NativeSelect
                      aria-label={`Role of ${member.displayName}`}
                      value={member.role}
                      disabled={act.isPending}
                      className="w-32"
                      onChange={(e) =>
                        act.mutate({
                          member,
                          kind: "role",
                          role: e.target.value as Role,
                        })
                      }
                    >
                      {ROLES.filter(
                        (r) => assignable.includes(r) || r === member.role
                      ).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    ROLE_LABEL[member.role]
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {member.teams.length === 0
                    ? "—"
                    : member.teams
                        .map((t) => `${t.name}${t.isLead ? " (lead)" : ""}`)
                        .join(", ")}
                </TableCell>
                <TableCell>
                  {member.status === "ACTIVE" ? (
                    <span className="text-muted-foreground">
                      {STATUS_LABEL.ACTIVE}
                    </span>
                  ) : (
                    <Badge
                      variant={
                        member.status === "DISABLED" ? "destructive" : "outline"
                      }
                    >
                      {STATUS_LABEL[member.status]}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {editable && holds("member:disable") && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Actions for ${member.displayName}`}
                          />
                        }
                      >
                        Manage
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {member.status === "ACTIVE" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              act.mutate({ member, kind: "disable" })
                            }
                          >
                            Pause access
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              act.mutate({ member, kind: "enable" })
                            }
                          >
                            Restore access
                          </DropdownMenuItem>
                        )}
                        {holds("member:remove") && (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setRemoving(member)}
                          >
                            Remove from workspace
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to this workspace at once and leave every team.
              Their tickets and history stay, still under their name. To bring
              them back, invite them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing !== null)
                  act.mutate({ member: removing, kind: "remove" })
                setRemoving(null)
              }}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PendingInvitations({ invitations }: { invitations: Invitation[] }) {
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: (invitation: Invitation) =>
      clientApi(`/invitations/${invitation.id}`, {
        method: "DELETE",
        schema: null,
      }),
    onSuccess: (_r, invitation) => {
      toast.success(`Invitation to ${invitation.email} withdrawn`)
      void queryClient.invalidateQueries({ queryKey: ["invitations"] })
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The invitation wasn't withdrawn.")),
  })
  return (
    <div className="mt-6 rounded-lg border border-border">
      <p className="border-b border-border px-4 py-2.5 text-sm font-medium">
        Waiting to join
      </p>
      <ul className="divide-y divide-border">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
          >
            <span>
              {invitation.email}
              <span className="ml-2 text-muted-foreground">
                as {ROLE_LABEL[invitation.role].toLowerCase()}, link expires{" "}
                {new Date(invitation.expiresAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(invitation)}
            >
              Withdraw
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
