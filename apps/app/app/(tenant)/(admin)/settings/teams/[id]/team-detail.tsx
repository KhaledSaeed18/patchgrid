"use client"

import type { Member, TeamDetail } from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { PageHeader, Section } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { ROLE_LABEL } from "@/lib/labels"

export function TeamDetailView({
  initial: team,
  candidates,
}: {
  initial: TeamDetail
  candidates: Member[]
}) {
  const { holds, membership } = useTenant()
  const router = useRouter()
  const canWrite = holds("team:write")
  // A lead manages their own team's members; an admin any team's. The API decides either way.
  const canManage = canWrite || team.lead?.membershipId === membership.id

  const change = useMutation({
    mutationFn: (request: {
      path: string
      method: "PUT" | "DELETE" | "PATCH"
      body?: unknown
      done: string
    }) =>
      clientApi(`/teams/${team.id}${request.path}`, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        schema: null,
      }).then(() => request.done),
    onSuccess: (done) => {
      toast.success(done)
      router.refresh()
    },
    onError: (error) =>
      toast.error(failureMessage(error, "That change didn't go through.")),
  })

  return (
    <>
      <PageHeader
        title={team.name}
        description={
          team.description ??
          (team.isActive ? undefined : "This team is deactivated.")
        }
        action={
          <Link
            href="/settings/teams"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            All teams
          </Link>
        }
      />

      <Section
        title="Members"
        description="Agents in this team see its tickets and are offered them first."
      >
        {team.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.members.map((member) => (
                <TableRow key={member.membershipId}>
                  <TableCell className="font-medium">
                    {member.displayName}
                    {member.isLead && (
                      <Badge variant="secondary" className="ml-2">
                        Lead
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {ROLE_LABEL[member.role]}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {canWrite && !member.isLead && team.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({
                            path: "/lead",
                            method: "PUT",
                            body: { membershipId: member.membershipId },
                            done: `${member.displayName} now leads ${team.name}`,
                          })
                        }
                      >
                        Make lead
                      </Button>
                    )}
                    {canManage && team.isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({
                            path: `/members/${member.membershipId}`,
                            method: "DELETE",
                            done: `${member.displayName} left ${team.name}`,
                          })
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {canManage && team.isActive && (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const id = String(
                new FormData(event.currentTarget).get("member") ?? ""
              )
              const member = candidates.find((c) => c.id === id)
              if (member !== undefined) {
                change.mutate({
                  path: `/members/${id}`,
                  method: "PUT",
                  done: `${member.displayName} joined ${team.name}`,
                })
              }
            }}
          >
            <NativeSelect
              name="member"
              aria-label="Member to add"
              defaultValue=""
              disabled={candidates.length === 0}
            >
              <option value="" disabled>
                {candidates.length === 0
                  ? "Every agent is already in this team"
                  : "Choose an agent to add"}
              </option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </NativeSelect>
            <Button
              type="submit"
              variant="outline"
              disabled={candidates.length === 0 || change.isPending}
            >
              Add
            </Button>
          </form>
        )}
      </Section>

      {canWrite && (
        <Section
          title="Details"
          description="Deactivating keeps the team and its history, and stops new work reaching it."
        >
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              const description = String(data.get("description") ?? "").trim()
              change.mutate({
                path: "",
                method: "PATCH",
                body: {
                  name: String(data.get("name")).trim(),
                  description: description === "" ? null : description,
                },
                done: "Team saved",
              })
            }}
          >
            <FieldGroup>
              <FormField
                id="name"
                name="name"
                label="Name"
                defaultValue={team.name}
                required
              />
              <FormField
                id="description"
                name="description"
                label="What it handles"
                defaultValue={team.description ?? ""}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={change.isPending}>
                  Save changes
                </Button>
                {team.lead !== null && team.isActive && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      change.mutate({
                        path: "/lead",
                        method: "PUT",
                        body: { membershipId: null },
                        done: "Lead cleared",
                      })
                    }
                  >
                    Clear lead
                  </Button>
                )}
                <Button
                  type="button"
                  variant={team.isActive ? "destructive" : "outline"}
                  onClick={() =>
                    change.mutate({
                      path: "",
                      method: "PATCH",
                      body: { isActive: !team.isActive },
                      done: team.isActive
                        ? "Team deactivated"
                        : "Team reactivated",
                    })
                  }
                >
                  {team.isActive ? "Deactivate team" : "Reactivate team"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </Section>
      )}
    </>
  )
}
