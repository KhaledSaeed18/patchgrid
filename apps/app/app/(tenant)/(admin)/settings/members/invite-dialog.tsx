"use client"

import { invitationSchema, type Role, type Team } from "@patchgrid/contracts"
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
import { Field, FieldGroup, FieldLabel } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import { useStepUp } from "@/components/mfa/step-up-dialog"
import { StepUpCancelled } from "@/lib/step-up"
import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { newIdempotencyKey } from "@/lib/idempotency"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { ROLE_LABEL } from "@/lib/labels"

/** One address, one role, optionally one team to start in. The link goes by email and works for 7 days. */
export function InviteDialog({
  teams,
  roles,
}: {
  teams: Team[]
  roles: Role[]
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  // Inviting an owner is the transfer of ownership: a step-up action (ADR-0029).
  const stepUp = useStepUp()
  const invite = useMutation({
    mutationFn: (form: { email: string; role: Role; teamId?: string }) =>
      stepUp.guard(() =>
        clientApi("/invitations", {
          method: "POST",
          body: form,
          schema: invitationSchema,
          idempotencyKey: newIdempotencyKey(),
        })
      ),
    onSuccess: (invitation) => {
      toast.success(`Invitation sent to ${invitation.email}`)
      void queryClient.invalidateQueries({ queryKey: ["invitations"] })
      setOpen(false)
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) invite.reset()
    },
  })
  const emailError =
    invite.error instanceof ApiError
      ? invite.error.fieldError("email")
      : undefined

  return (
    <>
      {stepUp.dialog}
      <Dialog
        open={open && !stepUp.waiting}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) invite.reset()
        }}
      >
        <DialogTrigger render={<Button />}>Invite people</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>
              They get an email with a link that works for 7 days, only for this
              address.
            </DialogDescription>
          </DialogHeader>
          <form
            id="invite"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              const teamId = String(data.get("teamId") ?? "")
              invite.mutate({
                email: String(data.get("email")),
                role: String(data.get("role")) as Role,
                ...(teamId === "" ? {} : { teamId }),
              })
            }}
          >
            <FieldGroup>
              {invite.error !== null && emailError === undefined && (
                <FormAlert>
                  {failureMessage(
                    invite.error,
                    "The invitation wasn't sent. Try again."
                  )}
                </FormAlert>
              )}
              <FormField
                id="invite-email"
                name="email"
                type="email"
                label="Email"
                required
                autoFocus
                error={emailError}
              />
              <Field>
                <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                <NativeSelect id="invite-role" name="role" defaultValue="AGENT">
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {teams.length > 0 && (
                <Field>
                  <FieldLabel htmlFor="invite-team">Team (optional)</FieldLabel>
                  <NativeSelect id="invite-team" name="teamId" defaultValue="">
                    <option value="">No team yet</option>
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type="submit" form="invite" disabled={invite.isPending}>
              {invite.isPending && <Spinner />}
              Send invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
