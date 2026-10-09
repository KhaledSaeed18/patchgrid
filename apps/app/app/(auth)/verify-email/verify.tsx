"use client"

import { loginResponseSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useEffect, useRef } from "react"

import { FormAlert } from "@/components/form-alert"
import { clientApi } from "@/lib/api/client"

/**
 * The emailed link completes signup and signs the person in (ADR-0031). It is
 * a POST, made once on arrival: a link-preview bot that only GETs the page
 * renders it without spending the token.
 */
export function Verify({ token }: { token: string }) {
  const started = useRef(false)
  const verify = useMutation({
    mutationFn: () =>
      clientApi("/auth/verify-email", {
        method: "POST",
        anonymous: true,
        body: { token },
        schema: loginResponseSchema,
      }),
    onSuccess: (response) => {
      // A brand-new account has no workspace yet: creating one is the next step.
      window.location.assign(
        response.workspaces.length === 0 ? "/new" : "/workspaces"
      )
    },
  })

  useEffect(() => {
    if (started.current) return
    started.current = true
    verify.mutate()
  }, [verify])

  if (verify.isError) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert>
          This link has expired or was already used. Sign in, and we’ll send a
          fresh one if you need it.
        </FormAlert>
        <Button render={<Link href="/login" />} size="lg">
          Go to sign in
        </Button>
      </div>
    )
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner /> Confirming your address…
    </p>
  )
}
