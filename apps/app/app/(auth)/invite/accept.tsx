"use client"

import {
  acceptInvitationResponseSchema,
  PASSWORD_MIN_LENGTH,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { workspaceOrigin } from "@/lib/config"

const enterWorkspace = (response: { session: { slug: string } }) => {
  window.location.assign(workspaceOrigin(response.session.slug))
}

export function AcceptAsMember({
  token,
  email,
}: {
  token: string
  email: string
}) {
  const accept = useMutation({
    mutationFn: () =>
      clientApi("/invitations/accept", {
        method: "POST",
        body: { token },
        schema: acceptInvitationResponseSchema,
      }),
    onSuccess: enterWorkspace,
  })
  return (
    <div className="flex flex-col gap-4">
      {accept.error !== null && <FormAlert>{failure(accept.error)}</FormAlert>}
      <p className="text-sm text-muted-foreground">
        You&rsquo;re signed in as{" "}
        <span className="text-foreground">{email}</span>.
      </p>
      <Button
        size="lg"
        onClick={() => accept.mutate()}
        disabled={accept.isPending || accept.isSuccess}
      >
        {(accept.isPending || accept.isSuccess) && <Spinner />}
        Join workspace
      </Button>
    </div>
  )
}

export function CreateAccountAndJoin({ token }: { token: string }) {
  const create = useMutation({
    mutationFn: (form: { name: string; password: string }) =>
      clientApi("/invitations/accept-new", {
        method: "POST",
        anonymous: true,
        body: { token, ...form },
        schema: acceptInvitationResponseSchema,
      }),
    onSuccess: enterWorkspace,
  })
  const fieldError = (path: string) =>
    create.error instanceof ApiError ? create.error.fieldError(path) : undefined
  const anyField =
    fieldError("name") !== undefined || fieldError("password") !== undefined

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        create.mutate({
          name: String(data.get("name")),
          password: String(data.get("password")),
        })
      }}
    >
      <FieldGroup>
        {create.error !== null && !anyField && (
          <FormAlert>{failure(create.error)}</FormAlert>
        )}
        <FormField
          id="name"
          name="name"
          label="Your name"
          autoComplete="name"
          required
          autoFocus
          error={fieldError("name")}
        />
        <FormField
          id="password"
          name="password"
          type="password"
          label="Choose a password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={fieldError("password")}
        />
        <Button
          type="submit"
          size="lg"
          disabled={create.isPending || create.isSuccess}
        >
          {(create.isPending || create.isSuccess) && <Spinner />}
          Create account and join
        </Button>
      </FieldGroup>
    </form>
  )
}

function failure(error: Error): string {
  if (error instanceof ApiError && error.type === "plan-limit-reached") {
    return "This workspace has no free agent seats right now. Ask whoever invited you to free one, then try again."
  }
  if (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 409)
  ) {
    return error.message
  }
  return "Joining didn't work just now. Try again in a moment."
}
