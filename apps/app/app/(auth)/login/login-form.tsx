"use client"

import { loginResponseSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"

import { FormField } from "@/components/form-field"
import { FormAlert } from "@/components/form-alert"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { parseNext } from "@/lib/next-url"

/**
 * Email and password. When the browser arrived from a workspace, the login
 * asks for that workspace's session in the same request and goes straight
 * back; otherwise it goes to the picker. One message for every failure: the
 * API does not say whether the address exists, and neither does this page.
 */
export function LoginForm({ next }: { next: string | undefined }) {
  const target = parseNext(next)
  const login = useMutation({
    mutationFn: (form: { email: string; password: string }) =>
      clientApi("/auth/login", {
        method: "POST",
        anonymous: true,
        body: {
          ...form,
          ...(target?.kind === "workspace" ? { slug: target.slug } : {}),
        },
        schema: loginResponseSchema,
      }),
    onSuccess: (response) => {
      if (target?.kind === "workspace" && response.session !== null) {
        window.location.assign(target.url)
      } else if (target?.kind === "path") {
        window.location.assign(target.path)
      } else {
        window.location.assign("/workspaces")
      }
    },
  })

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        login.mutate({
          email: String(data.get("email")),
          password: String(data.get("password")),
        })
      }}
    >
      <FieldGroup>
        {login.error !== null && (
          <FormAlert>{messageFor(login.error)}</FormAlert>
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
        <FormField
          id="password"
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          required
          description={
            <Link
              href="/reset-password"
              className="underline underline-offset-4"
            >
              Forgot your password?
            </Link>
          }
        />
        <Button
          type="submit"
          size="lg"
          disabled={login.isPending || login.isSuccess}
        >
          {(login.isPending || login.isSuccess) && <Spinner />}
          Sign in
        </Button>
      </FieldGroup>
    </form>
  )
}

function messageFor(error: Error): string {
  if (error instanceof ApiError && error.status === 401) {
    return "That email and password don't match an account. Check both, or reset your password."
  }
  if (error instanceof ApiError && error.type === "rate-limited") {
    return "Too many attempts from here. Wait a minute, then try again."
  }
  return "Signing in didn't work just now. Try again in a moment."
}
