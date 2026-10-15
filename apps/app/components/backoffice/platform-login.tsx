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
import { useEffect, useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import {
  EnrolForm,
  FactorForm,
  factorMessage,
} from "@/components/mfa/factor-form"
import { RecoveryCodes } from "@/components/mfa/recovery-codes"
import { ApiError } from "@/lib/api/errors"
import { platformApi } from "@/lib/api/platform"

type Stage =
  | { kind: "password" }
  | { kind: "verify" }
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
          ? { kind: "verify" }
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
            <FormAlert>{passwordMessage(password.error)}</FormAlert>
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
      <FactorForm
        onSubmit={(proof) => verify.mutate(proof)}
        pending={verify.isPending || verify.isSuccess}
        error={verify.error}
        submitLabel="Sign in"
      />
    )
  }

  if (stage.kind === "enrol") {
    if (stage.enrolment === null) {
      return enrol.error !== null ? (
        <FormAlert>{factorMessage(enrol.error)}</FormAlert>
      ) : (
        <Spinner />
      )
    }
    return (
      <EnrolForm
        enrolment={stage.enrolment}
        intro="Operators sign in with a second factor. Scan this with an authenticator app, then enter the code it shows."
        onConfirm={(code) => confirm.mutate(code)}
        pending={confirm.isPending}
        error={confirm.error}
        submitLabel="Turn on and sign in"
      />
    )
  }

  return <RecoveryCodes codes={stage.codes} onDone={done} />
}

function passwordMessage(error: Error): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many attempts from here. Wait a minute, then try again."
  if (error instanceof ApiError && error.status === 401)
    return "That email and password don't match an operator."
  return "Signing in didn't work just now. Try again in a moment."
}
