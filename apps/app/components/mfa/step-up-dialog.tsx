"use client"

import { mfaStatusSchema, stepUpResponseSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi, currentSlug } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { isStepUpRequired, StepUpCancelled } from "@/lib/step-up"

import { FactorForm, type FactorProof } from "./factor-form"

/**
 * Step-up re-authentication (ADR-0029): the API refused an irreversible
 * action until the session re-proves itself. The proof is the authenticator
 * when one is enrolled, and only then the password. On success the API
 * re-issued this workspace's cookies with the proof on them, and the caller
 * retries exactly what it was doing.
 */
export function StepUpDialog({
  open,
  onProved,
  onCancel,
}: {
  open: boolean
  onProved: () => void
  onCancel: () => void
}) {
  const status = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => clientApi("/auth/mfa", { schema: mfaStatusSchema }),
    enabled: open,
  })
  const prove = useMutation({
    mutationFn: (proof: FactorProof | { password: string }) =>
      clientApi("/auth/step-up", {
        method: "POST",
        body: { slug: currentSlug(), ...proof },
        schema: stepUpResponseSchema,
      }),
    onSuccess: onProved,
  })

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            This can&apos;t be undone, so we check once more. The confirmation
            lasts five minutes.
          </DialogDescription>
        </DialogHeader>
        {status.data === undefined ? (
          <Spinner />
        ) : status.data.enrolled ? (
          <FactorForm
            onSubmit={(proof) => prove.mutate(proof)}
            pending={prove.isPending}
            error={prove.error}
            submitLabel="Confirm"
          />
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              prove.mutate({
                password: String(
                  new FormData(event.currentTarget).get("password") ?? ""
                ),
              })
            }}
          >
            <FieldGroup>
              {prove.error !== null && (
                <FormAlert>{passwordMessage(prove.error)}</FormAlert>
              )}
              <FormField
                id="step-up-password"
                name="password"
                type="password"
                label="Your password"
                autoComplete="current-password"
                required
                autoFocus
                description="Set up an authenticator under your account to confirm with a code instead."
              />
              <Button type="submit" size="lg" disabled={prove.isPending}>
                {prove.isPending && <Spinner />}
                Confirm
              </Button>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function passwordMessage(error: Error): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many wrong attempts. Try again later."
  if (error instanceof ApiError && error.status === 400)
    return "That password didn't match."
  return "That didn't work just now. Try again in a moment."
}

/**
 * Wraps an action so that a `step-up-required` refusal opens the dialog and,
 * once proved, runs the action again. A closed dialog rejects with
 * `StepUpCancelled`, which callers treat as "nothing happened". `waiting`
 * lets a dialog that triggered the action step aside while the proof is
 * taken, rather than stacking two dialogs.
 */
export function useStepUp() {
  const [waiting, setWaiting] = useState<{
    resolve: () => void
    reject: (error: Error) => void
  } | null>(null)

  const guard = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (!isStepUpRequired(error)) throw error
      await new Promise<void>((resolve, reject) =>
        setWaiting({ resolve, reject })
      )
      return run()
    }
  }, [])

  const dialog = (
    <StepUpDialog
      open={waiting !== null}
      onProved={() => {
        waiting?.resolve()
        setWaiting(null)
      }}
      onCancel={() => {
        waiting?.reject(new StepUpCancelled())
        setWaiting(null)
      }}
    />
  )
  return { guard, dialog, waiting: waiting !== null }
}
