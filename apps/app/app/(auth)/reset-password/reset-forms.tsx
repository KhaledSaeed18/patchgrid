"use client"

import { PASSWORD_MIN_LENGTH } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"

/**
 * Asking for a link. The answer is the same whether or not the address has an
 * account (ADR-0031), so the confirmation says what WILL happen if it does.
 */
export function RequestResetForm() {
  const request = useMutation({
    mutationFn: (email: string) =>
      clientApi("/auth/password-reset", {
        method: "POST",
        anonymous: true,
        body: { email },
        schema: null,
      }),
  })

  if (request.isSuccess) {
    return (
      <FormAlert tone="info">
        If that address has a Patchgrid account, a reset link is on its way. It
        works for 30 minutes.
      </FormAlert>
    )
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        request.mutate(String(new FormData(event.currentTarget).get("email")))
      }}
    >
      <FieldGroup>
        {request.error !== null && (
          <FormAlert>{failure(request.error)}</FormAlert>
        )}
        <FormField
          id="email"
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          required
          autoFocus
        />
        <Button type="submit" size="lg" disabled={request.isPending}>
          {request.isPending && <Spinner />}
          Send reset link
        </Button>
      </FieldGroup>
    </form>
  )
}

/** Choosing the new password from the emailed link. Every session ends with it, this browser's included. */
export function ConfirmResetForm({ token }: { token: string }) {
  const confirm = useMutation({
    mutationFn: (password: string) =>
      clientApi("/auth/password-reset/confirm", {
        method: "POST",
        anonymous: true,
        body: { token, password },
        schema: null,
      }),
  })

  if (confirm.isSuccess) {
    return (
      <FieldGroup>
        <FormAlert tone="info">
          Your password is changed, and every other session is signed out.
        </FormAlert>
        <Button render={<Link href="/login" />} size="lg">
          Sign in
        </Button>
      </FieldGroup>
    )
  }

  const fieldError =
    confirm.error instanceof ApiError
      ? confirm.error.fieldError("password")
      : undefined
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        confirm.mutate(
          String(new FormData(event.currentTarget).get("password"))
        )
      }}
    >
      <FieldGroup>
        {confirm.error !== null && fieldError === undefined && (
          <FormAlert>{failure(confirm.error)}</FormAlert>
        )}
        <FormField
          id="password"
          name="password"
          type="password"
          label="New password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          autoFocus
          description={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}
          error={fieldError}
        />
        <Button type="submit" size="lg" disabled={confirm.isPending}>
          {confirm.isPending && <Spinner />}
          Change password
        </Button>
      </FieldGroup>
    </form>
  )
}

function failure(error: Error): string {
  if (error instanceof ApiError && error.status === 401) {
    return "This reset link has expired or was already used. Ask for a new one below."
  }
  if (error instanceof ApiError && error.type === "rate-limited") {
    return "Too many requests from here. Wait a minute, then try again."
  }
  return "That didn't go through. Try again in a moment."
}
