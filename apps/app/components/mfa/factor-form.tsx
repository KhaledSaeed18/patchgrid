"use client"

import type {
  FactorMethod,
  MfaEnrolment,
  PasskeyProof,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { ApiError } from "@/lib/api/errors"
import {
  assertWithPasskey,
  PasskeyCancelled,
  usePasskeysAvailable,
} from "@/lib/passkeys"

import { QrCode } from "./qr-code"

/** A code from the authenticator, a passkey, or — when offered — one recovery code. */
export type FactorProof =
  { code: string } | { recoveryCode: string } | { passkey: PasskeyProof }

/**
 * The one form every second-factor step shares (ADR-0045, ADR-0053): a
 * passkey when the person holds one and this browser can use it, six digits
 * when they hold an authenticator app, and a recovery code when their
 * devices are gone. The caller says what submitting does, and where the
 * passkey's challenge comes from.
 */
export function FactorForm({
  onSubmit,
  pending,
  error,
  submitLabel,
  methods = ["totp"],
  passkeyOptions,
  anonymous = false,
  allowRecovery = true,
  autoFocus = true,
  children,
}: {
  onSubmit: (proof: FactorProof) => void
  pending: boolean
  error: Error | null
  submitLabel: string
  /** The kinds the person holds; the form offers only those. */
  methods?: readonly FactorMethod[]
  /** Where a passkey's challenge is issued — the second step's, or a `pg_id` holder's proof. */
  passkeyOptions?: string
  /** No session behind the request yet: the second step of login. */
  anonymous?: boolean
  allowRecovery?: boolean
  autoFocus?: boolean
  children?: React.ReactNode
}) {
  const hasTotp = methods.includes("totp")
  const canPasskey = usePasskeysAvailable()
  const offerPasskey =
    canPasskey && methods.includes("passkey") && passkeyOptions !== undefined
  const [useRecovery, setUseRecovery] = useState(false)
  const [prompting, setPrompting] = useState(false)
  const [passkeyError, setPasskeyError] = useState<Error | null>(null)
  const showField = hasTotp || useRecovery

  const provePasskey = async () => {
    if (passkeyOptions === undefined) return
    setPasskeyError(null)
    setPrompting(true)
    try {
      onSubmit({ passkey: await assertWithPasskey(passkeyOptions, anonymous) })
    } catch (failure) {
      if (!(failure instanceof PasskeyCancelled))
        setPasskeyError(
          failure instanceof Error ? failure : new Error("failed")
        )
    } finally {
      setPrompting(false)
    }
  }

  const shown = passkeyError ?? error
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
        {shown !== null && <FormAlert>{factorMessage(shown)}</FormAlert>}
        {offerPasskey && !useRecovery && (
          <Button
            type="button"
            size="lg"
            variant={hasTotp ? "outline" : "default"}
            disabled={pending || prompting}
            onClick={() => void provePasskey()}
          >
            {(pending || prompting) && !hasTotp && <Spinner />}
            Use a passkey
          </Button>
        )}
        {!offerPasskey && !hasTotp && !useRecovery && (
          <p className="text-sm text-pretty text-muted-foreground">
            Your second factor is a passkey, and this browser can&apos;t use one
            here. Use a recovery code, or try from a browser on a secure
            connection.
          </p>
        )}
        {showField && (
          <>
            <FormField
              key={useRecovery ? "recovery" : "code"}
              id="code"
              name="code"
              label={
                useRecovery ? "Recovery code" : "Code from your authenticator"
              }
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              placeholder={useRecovery ? "abcde-fghij" : "123456"}
              required
              autoFocus={autoFocus && !offerPasskey}
            />
            <Button type="submit" size="lg" disabled={pending}>
              {pending && <Spinner />}
              {submitLabel}
            </Button>
          </>
        )}
        {allowRecovery && (
          <button
            type="button"
            className="w-fit text-sm text-muted-foreground underline underline-offset-4"
            onClick={() => setUseRecovery((current) => !current)}
          >
            {useRecovery ? "Use your device instead" : "Use a recovery code"}
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
  if (error instanceof ApiError && error.fieldError("passkey") !== undefined)
    return "That passkey wasn't accepted. Try again, or use another way in."
  if (!(error instanceof ApiError))
    return "Your browser couldn't use a passkey just now. Try again, or use another way in."
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many wrong codes. This factor is locked for a while — try again later."
  if (error instanceof ApiError && error.status === 400)
    return "That code didn't work. Codes change every 30 seconds — try the current one."
  if (error instanceof ApiError && error.status === 401)
    return "This took too long. Start again."
  return "That didn't work just now. Try again in a moment."
}
