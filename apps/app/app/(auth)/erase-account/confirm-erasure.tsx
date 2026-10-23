"use client"

import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"

import { FormAlert } from "@/components/form-alert"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { marketingOrigin } from "@/lib/config"

/** Spends the link. A refusal — a lapsed link, a workspace with no other owner — says why, and nothing is erased. */
export function ConfirmErasure({ token }: { token: string }) {
  const confirm = useMutation({
    mutationFn: () =>
      clientApi("/auth/account/erase/confirm", {
        method: "POST",
        anonymous: true,
        body: { token },
        schema: null,
      }),
  })
  if (confirm.isSuccess) {
    return (
      <FormAlert tone="info">
        Your account is erased. A last email confirms it.{" "}
        <a href={marketingOrigin()} className="underline underline-offset-4">
          Back to Patchgrid
        </a>
      </FormAlert>
    )
  }
  return (
    <div className="grid gap-4">
      {confirm.error !== null && (
        <FormAlert>
          {failureMessage(confirm.error, "Your account wasn't erased.")}
        </FormAlert>
      )}
      <p className="text-sm text-muted-foreground">
        If you are a workspace&apos;s only owner, make someone else an owner, or
        delete it, first.
      </p>
      <Button
        variant="destructive"
        className="w-fit"
        disabled={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {confirm.isPending && <Spinner />}
        Erase my account
      </Button>
    </div>
  )
}
