"use client"

import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"

import { FormAlert } from "@/components/form-alert"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

/**
 * Erasing without a password (ADR-0044 erratum): a single-use link to the
 * account's own address, for an account a workspace's identity provider made.
 */
export function ErasureLink({ email }: { email: string }) {
  const request = useMutation({
    mutationFn: () =>
      clientApi("/auth/account/erase/link", {
        method: "POST",
        anonymous: true,
        body: { email },
        schema: null,
      }),
  })
  if (request.isSuccess) {
    return (
      <FormAlert tone="info">
        A link to erase this account is on its way to {email}. It works once, for 30 minutes.
      </FormAlert>
    )
  }
  return (
    <div className="grid gap-2">
      {request.error !== null && <FormAlert>{failureMessage(request.error, "The link wasn't sent.")}</FormAlert>}
      <Button type="button" variant="outline" className="w-fit" disabled={request.isPending} onClick={() => request.mutate()}>
        {request.isPending && <Spinner />}
        Email me a link to erase it instead
      </Button>
    </div>
  )
}
