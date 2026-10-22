"use client"

import type { FactorMethod } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { ApiError } from "@/lib/api/errors"

import { FactorForm, type FactorProof } from "./factor-form"

/** A proof by the step-up rule: a factor, or the password only when there is none. */
export type HolderProof = FactorProof | { password: string }

/** Where a `pg_id` holder's passkey challenge is issued. */
export const PROOF_OPTIONS = "/auth/passkeys/proof/options"

/**
 * The step-up rule as a form (ADR-0045, ADR-0053): any factor the person
 * holds proves them, and the password only when they hold none — so a
 * stolen password cannot stand in for a factor that exists. Step-up,
 * adding a passkey and setting up the authenticator app all ask this way.
 */
export function HolderProofForm({
  methods,
  onSubmit,
  pending,
  error,
  submitLabel,
  passwordHint,
}: {
  methods: readonly FactorMethod[]
  onSubmit: (proof: HolderProof) => void
  pending: boolean
  error: Error | null
  submitLabel: string
  passwordHint?: string
}) {
  if (methods.length > 0) {
    return (
      <FactorForm
        methods={methods}
        passkeyOptions={PROOF_OPTIONS}
        onSubmit={onSubmit}
        pending={pending}
        error={error}
        submitLabel={submitLabel}
      />
    )
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({
          password: String(
            new FormData(event.currentTarget).get("password") ?? ""
          ),
        })
      }}
    >
      <FieldGroup>
        {error !== null && <FormAlert>{passwordMessage(error)}</FormAlert>}
        <FormField
          id="holder-password"
          name="password"
          type="password"
          label="Your password"
          autoComplete="current-password"
          required
          autoFocus
          {...(passwordHint === undefined ? {} : { description: passwordHint })}
        />
        <Button type="submit" size="lg" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </FieldGroup>
    </form>
  )
}

export function passwordMessage(error: Error): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many wrong attempts. Try again later."
  if (error instanceof ApiError && error.status === 400)
    return "That password didn't match."
  return "That didn't work just now. Try again in a moment."
}
