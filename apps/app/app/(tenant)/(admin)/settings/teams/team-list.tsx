"use client"

import { type Team, teamDetailSchema } from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@patchgrid/ui/components/dialog"
import { FieldGroup } from "@patchgrid/ui/components/field"
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
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { FormField } from "@/components/form-field"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"

export function TeamList({ initial }: { initial: Team[] }) {
  const { holds } = useTenant()
  return (
    <div className="px-6 py-6 md:px-10">
      {holds("team:write") && (
        <div className="flex justify-end">
          <CreateTeam />
        </div>
      )}
      {initial.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No teams yet. Create one to start routing tickets to it.
        </p>
      ) : (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Team</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead className="text-right">Members</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((team) => (
              <TableRow
                key={team.id}
                className={team.isActive ? undefined : "opacity-60"}
              >
                <TableCell>
                  <Link
                    href={`/settings/teams/${team.id}`}
                    className="font-medium hover:underline"
                  >
                    {team.name}
                  </Link>
                  {!team.isActive && (
                    <Badge variant="outline" className="ml-2">
                      Deactivated
                    </Badge>
                  )}
                  {team.description !== null && (
                    <p className="text-xs text-muted-foreground">
                      {team.description}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {team.lead?.displayName ?? "No lead"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {team.memberCount}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function CreateTeam() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const create = useMutation({
    mutationFn: (form: { name: string; description?: string }) =>
      clientApi("/teams", {
        method: "POST",
        body: form,
        schema: teamDetailSchema,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (team) => router.push(`/settings/teams/${team.id}`),
  })
  const nameError =
    create.error instanceof ApiError
      ? (create.error.fieldError("name") ??
        (create.error.status === 409
          ? "A team with that name already exists."
          : undefined))
      : undefined
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Create team</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>
            You can add members and choose a lead next.
          </DialogDescription>
        </DialogHeader>
        <form
          id="create-team"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const description = String(data.get("description") ?? "").trim()
            create.mutate({
              name: String(data.get("name")).trim(),
              ...(description === "" ? {} : { description }),
            })
          }}
        >
          <FieldGroup>
            <FormField
              id="team-name"
              name="name"
              label="Name"
              placeholder="Field Support"
              required
              autoFocus
              error={nameError}
            />
            <FormField
              id="team-description"
              name="description"
              label="What it handles (optional)"
              placeholder="Laptops, printers and desk moves"
            />
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="submit" form="create-team" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Create team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
