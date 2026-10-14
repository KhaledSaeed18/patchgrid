"use client"

import {
  type MfaEnrolment,
  mfaEnrolmentSchema,
  platformLoginStepSchema,
  recoveryCodesSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import QRCode from "qrcode"
import { useEffect, useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { ApiError } from "@/lib/api/errors"
import { platformApi } from "@/lib/api/platform"

type Stage =
  | { kind: "password" }
  | { kind: "verify"; useRecovery: boolean }
  | { kind: "enrol"; enrolment: MfaEnrolment | null }
  | { kind: "recovery"; codes: string[] }

/**
 * Sign-in in three steps (ADR-0040): the password, which only ever leads to
 * a second factor; the factor — or, the first time, enrolling one; and, after
 * enrolling, the recovery codes, shown here once and never again.
 */
export function PlatformLogin({ next }: { next: string }) {
  const [stage, setStage] = useState<Stage>({ kind: "password" })
  const done = () => window.location.assign(next)

  const password = useMutation({
    mutationFn: (form: { email: string; password: string }) =>
      platformApi("/auth/login", {
        method: "POST",
        anonymous: true,
        body: form,
        schema: platformLoginStepSchema,
      }),
    onSuccess: (step) =>
      setStage(
        step.next === "verify"
          ? { kind: "verify", useRecovery: false }
          : { kind: "enrol", enrolment: null }
      ),
  })
  const enrol = useMutation({
    mutationFn: () =>
      platformApi("/auth/mfa/enrol", {
        method: "POST",
        anonymous: true,
        schema: mfaEnrolmentSchema,
      }),
    onSuccess: (enrolment) => setStage({ kind: "enrol", enrolment }),
  })
  const confirm = useMutation({
    mutationFn: (code: string) =>
      platformApi("/auth/mfa/confirm", {
        method: "POST",
        anonymous: true,
        body: { code },
        schema: recoveryCodesSchema,
      }),
    onSuccess: (result) =>
      setStage({ kind: "recovery", codes: result.recoveryCodes }),
  })
  const verify = useMutation({
    mutationFn: (body: { code: string } | { recoveryCode: string }) =>
      platformApi("/auth/mfa", {
        method: "POST",
        anonymous: true,
        body,
        schema: null,
      }),
    onSuccess: done,
  })
  const { mutate: startEnrolment, isIdle: enrolmentIdle } = enrol
  useEffect(() => {
    if (stage.kind === "enrol" && stage.enrolment === null && enrolmentIdle)
      startEnrolment()
  }, [stage, enrolmentIdle, startEnrolment])

  if (stage.kind === "password") {
    return (
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          password.mutate({
            email: String(data.get("email")),
            password: String(data.get("password")),
          })
        }}
      >
        <FieldGroup>
          {password.error !== null && (
            <FormAlert>{messageFor(password.error, "password")}</FormAlert>
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
          />
          <Button type="submit" size="lg" disabled={password.isPending}>
            {password.isPending && <Spinner />}
            Continue
          </Button>
        </FieldGroup>
      </form>
    )
  }

  if (stage.kind === "verify") {
    return (
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const value = String(
            new FormData(event.currentTarget).get("code") ?? ""
          ).trim()
          verify.mutate(
            stage.useRecovery ? { recoveryCode: value } : { code: value }
          )
        }}
      >
        <FieldGroup>
          {verify.error !== null && (
            <FormAlert>{messageFor(verify.error, "code")}</FormAlert>
          )}
          <FormField
            key={stage.useRecovery ? "recovery" : "code"}
            id="code"
            name="code"
            label={
              stage.useRecovery
                ? "Recovery code"
                : "Code from your authenticator"
            }
            inputMode={stage.useRecovery ? "text" : "numeric"}
            autoComplete="one-time-code"
            placeholder={stage.useRecovery ? "abcde-fghij" : "123456"}
            required
            autoFocus
          />
          <Button
            type="submit"
            size="lg"
            disabled={verify.isPending || verify.isSuccess}
          >
            {(verify.isPending || verify.isSuccess) && <Spinner />}
            Sign in
          </Button>
          <button
            type="button"
            className="w-fit text-sm text-muted-foreground underline underline-offset-4"
            onClick={() =>
              setStage({ kind: "verify", useRecovery: !stage.useRecovery })
            }
          >
            {stage.useRecovery
              ? "Use your authenticator instead"
              : "Use a recovery code"}
          </button>
        </FieldGroup>
      </form>
    )
  }

  if (stage.kind === "enrol") {
    if (stage.enrolment === null) {
      return enrol.error !== null ? (
        <FormAlert>{messageFor(enrol.error, "code")}</FormAlert>
      ) : (
        <Spinner />
      )
    }
    return (
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          confirm.mutate(
            String(new FormData(event.currentTarget).get("code") ?? "").trim()
          )
        }}
      >
        <FieldGroup>
          <p className="text-sm text-pretty text-muted-foreground">
            Operators sign in with a second factor. Scan this with an
            authenticator app, then enter the code it shows.
          </p>
          <QrCode value={stage.enrolment.otpauthUri} />
          <p className="text-xs text-muted-foreground">
            Or type this key:{" "}
            <span className="font-mono break-all text-foreground">
              {stage.enrolment.secret}
            </span>
          </p>
          {confirm.error !== null && (
            <FormAlert>{messageFor(confirm.error, "code")}</FormAlert>
          )}
          <FormField
            id="code"
            name="code"
            label="Code from your authenticator"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
          />
          <Button type="submit" size="lg" disabled={confirm.isPending}>
            {confirm.isPending && <Spinner />}
            Turn on and sign in
          </Button>
        </FieldGroup>
      </form>
    )
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-pretty">
        These recovery codes each sign you in once if you lose your
        authenticator. <strong>They are shown only now.</strong> Keep them
        somewhere safe.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-lg border border-border p-4 font-mono text-sm"
      >
        {stage.codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button size="lg" onClick={done}>
        I&apos;ve saved them — continue
      </Button>
    </div>
  )
}

/** The authenticator's QR code, drawn here: the secret never leaves the browser for an image service. */
function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void QRCode.toDataURL(value, { margin: 1, width: 192 }).then((url) => {
      if (live) setSrc(url)
    })
    return () => {
      live = false
    }
  }, [value])
  return src === null ? (
    <div className="size-48 rounded-md bg-muted" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- a data URL drawn in the browser, not an asset to optimise
    <img
      src={src}
      alt="QR code for your authenticator app"
      className="size-48 rounded-md border border-border"
    />
  )
}

function messageFor(error: Error, step: "password" | "code"): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many attempts from here. Wait a minute, then try again."
  if (step === "password" && error instanceof ApiError && error.status === 401)
    return "That email and password don't match an operator."
  if (step === "code" && error instanceof ApiError && error.status === 400)
    return "That code didn't work. Codes change every 30 seconds — try the current one."
  if (error instanceof ApiError && error.status === 401)
    return "This sign-in took too long. Start again."
  return "Signing in didn't work just now. Try again in a moment."
}
