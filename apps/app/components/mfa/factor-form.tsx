"use client"

import type { MfaEnrolment } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { ApiError } from "@/lib/api/errors"

import { QrCode } from "./qr-code"

/** A code from the authenticator, or — when offered — one recovery code. */
export type FactorProof = { code: string } | { recoveryCode: string }

/**
 * The one form every second-factor step shares: six digits, or a recovery
 * code when the authenticator is gone. The caller says what submitting does.
 */
export function FactorForm({
  onSubmit,
  pending,
  error,
  submitLabel,
  allowRecovery = true,
  autoFocus = true,
  children,
}: {
  onSubmit: (proof: FactorProof) => void
  pending: boolean
  error: Error | null
  submitLabel: string
  allowRecovery?: boolean
  autoFocus?: boolean
  children?: React.ReactNode
}) {
  const [useRecovery, setUseRecovery] = useState(false)
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const value = String(
          new FormData(event.currentTarget).get("code") ?? ""
        ).trim()
        onSubmit(useRecovery ? { recoveryCode: value } : { code: value })
      }}
    >
      <FieldGroup>
        {children}
        {error !== null && <FormAlert>{factorMessage(error)}</FormAlert>}
        <FormField
          key={useRecovery ? "recovery" : "code"}
          id="code"
          name="code"
          label={useRecovery ? "Recovery code" : "Code from your authenticator"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          placeholder={useRecovery ? "abcde-fghij" : "123456"}
          required
          autoFocus={autoFocus}
        />
        <Button type="submit" size="lg" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
        {allowRecovery && (
          <button
            type="button"
            className="w-fit text-sm text-muted-foreground underline underline-offset-4"
            onClick={() => setUseRecovery((current) => !current)}
          >
            {useRecovery
              ? "Use your authenticator instead"
              : "Use a recovery code"}
          </button>
        )}
      </FieldGroup>
    </form>
  )
}

/** Scan, then prove one code: confirm-before-activate (ADR-0029). */
export function EnrolForm({
  enrolment,
  intro,
  onConfirm,
  pending,
  error,
  submitLabel,
}: {
  enrolment: MfaEnrolment
  intro: React.ReactNode
  onConfirm: (code: string) => void
  pending: boolean
  error: Error | null
  submitLabel: string
}) {
  return (
    <FactorForm
      onSubmit={(proof) => {
        if ("code" in proof) onConfirm(proof.code)
      }}
      pending={pending}
      error={error}
      submitLabel={submitLabel}
      allowRecovery={false}
    >
      <p className="text-sm text-pretty text-muted-foreground">{intro}</p>
      <QrCode value={enrolment.otpauthUri} />
      <p className="text-xs text-muted-foreground">
        Or type this key:{" "}
        <span className="font-mono break-all text-foreground">
          {enrolment.secret}
        </span>
      </p>
    </FactorForm>
  )
}

export function factorMessage(error: Error): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many wrong codes. This factor is locked for a while — try again later."
  if (error instanceof ApiError && error.status === 400)
    return "That code didn't work. Codes change every 30 seconds — try the current one."
  if (error instanceof ApiError && error.status === 401)
    return "This took too long. Start again."
  return "That didn't work just now. Try again in a moment."
}
