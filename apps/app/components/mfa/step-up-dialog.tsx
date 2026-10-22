"use client"

import { mfaStatusSchema, stepUpResponseSchema } from "@patchgrid/contracts"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useCallback, useState } from "react"

import { clientApi, currentSlug } from "@/lib/api/client"
import { isStepUpRequired, StepUpCancelled } from "@/lib/step-up"

import { type HolderProof, HolderProofForm } from "./holder-proof-form"

/**
 * Step-up re-authentication (ADR-0029): the API refused an irreversible
 * action until the session re-proves itself. The proof is any factor the
 * person holds — a passkey, a code — and only when they hold none, the
 * password. On success the API re-issued this workspace's cookies with the
 * proof on them, and the caller retries exactly what it was doing.
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
    mutationFn: (proof: HolderProof) =>
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
        ) : (
          <HolderProofForm
            methods={status.data.methods}
            onSubmit={(proof) => prove.mutate(proof)}
            pending={prove.isPending}
            error={prove.error}
            submitLabel="Confirm"
            passwordHint="Add a passkey or an authenticator app under your account to confirm with that instead."
          />
        )}
      </DialogContent>
    </Dialog>
  )
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
