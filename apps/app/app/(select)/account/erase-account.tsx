"use client"

import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"

/**
 * Deleting one's own account (ADR-0028, ADR-0044): the password again, and a
 * plain statement of what goes and what stays before anything happens.
 */
export function EraseAccount() {
  const [password, setPassword] = useState("")
  const erase = useMutation({
    mutationFn: () =>
      clientApi("/auth/account/erase", {
        method: "POST",
        body: { password },
        schema: null,
      }),
    onSuccess: () => window.location.assign("/login"),
  })
  const problem =
    erase.error instanceof ApiError
      ? (erase.error.fieldError("password") ??
        erase.error.problem?.detail ??
        "Your account wasn't deleted.")
      : erase.isError
        ? "Your account wasn't deleted."
        : null
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        erase.mutate()
      }}
    >
      <div className="grid gap-2 text-sm leading-relaxed">
        <p className="font-medium">Delete your account</p>
        <p className="text-muted-foreground">
          Your name and address leave every workspace you are in, and you are
          signed out everywhere. What you wrote — tickets, comments — stays with
          those workspaces, under &ldquo;Former member&rdquo;. This cannot be
          undone.
        </p>
        <p className="text-muted-foreground">
          If you are a workspace&apos;s only owner, make someone else an owner,
          or delete it, first.
        </p>
      </div>
      {problem !== null && <FormAlert>{problem}</FormAlert>}
      <FormField
        id="password"
        label="Your password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button
        type="submit"
        variant="destructive"
        className="w-fit"
        disabled={password === "" || erase.isPending}
      >
        {erase.isPending && <Spinner />}
        Delete my account
      </Button>
    </form>
  )
}
