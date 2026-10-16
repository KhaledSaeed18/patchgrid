"use client"

import {
  type MfaEnrolment,
  mfaEnrolmentSchema,
  mfaStatusSchema,
  recoveryCodesSchema,
} from "@patchgrid/contracts"
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import {
  EnrolForm,
  FactorForm,
  factorMessage,
  type FactorProof,
} from "@/components/mfa/factor-form"
import { RecoveryCodes } from "@/components/mfa/recovery-codes"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { ROOT_DOMAIN } from "@/lib/config"

type Stage =
  | { kind: "idle" }
  | { kind: "enrol"; enrolment: MfaEnrolment }
  | { kind: "recovery"; codes: string[] }
  | { kind: "regenerate" }
  | { kind: "disable" }
  | { kind: "password" }

/**
 * Set up, replace the recovery codes, or turn off (ADR-0029). Every change
 * is proved by the factor itself — never by the password alone — and the
 * recovery codes are shown exactly once.
 */
export function Security({
  initialEnrolled,
  requiredBy,
}: {
  initialEnrolled: boolean
  requiredBy: string | null
}) {
  const queryClient = useQueryClient()
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const status = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => clientApi("/auth/mfa", { schema: mfaStatusSchema }),
    initialData: {
      enrolled: initialEnrolled,
      confirmedAt: null,
      recoveryCodesRemaining: 0,
    },
  })
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["mfa-status"] })

  // The password first: a session alone must not be able to set the factor (ADR-0045).
  const enrol = useMutation({
    mutationFn: (password: string) =>
      clientApi("/auth/mfa/enrol", {
        method: "POST",
        body: { password },
        schema: mfaEnrolmentSchema,
      }),
    onSuccess: (enrolment) => setStage({ kind: "enrol", enrolment }),
  })
  const confirm = useMutation({
    mutationFn: (code: string) =>
      clientApi("/auth/mfa/confirm", {
        method: "POST",
        body: { code },
        schema: recoveryCodesSchema,
      }),
    onSuccess: (result) => {
      setStage({ kind: "recovery", codes: result.recoveryCodes })
      void refresh()
    },
  })
  const regenerate = useMutation({
    mutationFn: (proof: FactorProof) =>
      clientApi("/auth/mfa/recovery-codes", {
        method: "POST",
        body: proof,
        schema: recoveryCodesSchema,
      }),
    onSuccess: (result) => {
      setStage({ kind: "recovery", codes: result.recoveryCodes })
      void refresh()
    },
  })
  const disable = useMutation({
    mutationFn: (proof: FactorProof) =>
      clientApi("/auth/mfa/disable", {
        method: "POST",
        body: proof,
        schema: null,
      }),
    onSuccess: () => {
      setStage({ kind: "idle" })
      toast.success("Two-factor authentication is off.")
      void refresh()
    },
  })

  if (stage.kind === "enrol") {
    return (
      <EnrolForm
        enrolment={stage.enrolment}
        intro="Scan this with an authenticator app — 1Password, Google Authenticator, Aegis, any of them — then enter the code it shows."
        onConfirm={(code) => confirm.mutate(code)}
        pending={confirm.isPending}
        error={confirm.error}
        submitLabel="Turn on"
      />
    )
  }

  if (stage.kind === "recovery") {
    return (
      <RecoveryCodes
        codes={stage.codes}
        onDone={() => setStage({ kind: "idle" })}
        doneLabel="I've saved them"
      />
    )
  }

  const enrolled = status.data.enrolled
  return (
    <div className="grid gap-6">
      {requiredBy !== null && !enrolled && (
        <FormAlert tone="info">
          <span className="font-mono">
            {requiredBy}.{ROOT_DOMAIN}
          </span>{" "}
          requires two-factor authentication. Set it up here, then open the
          workspace again.
        </FormAlert>
      )}
      <div className="grid gap-2 text-sm leading-relaxed">
        <p className="font-medium">
          {enrolled ? "On" : "Off"}
          {enrolled && status.data.confirmedAt !== null && (
            <span className="font-normal text-muted-foreground">
              {" "}
              since {new Date(status.data.confirmedAt).toLocaleDateString()}
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {enrolled
            ? `Signing in takes your password and a code from your authenticator app. ${String(status.data.recoveryCodesRemaining)} of 10 recovery codes left.`
            : "Your password alone signs you in. An authenticator app adds a code that changes every 30 seconds, so a stolen password is not enough."}
        </p>
      </div>
      {enrolled ? (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => setStage({ kind: "regenerate" })}
          >
            New recovery codes
          </Button>
          <Button
            variant="outline"
            onClick={() => setStage({ kind: "disable" })}
          >
            Turn off
          </Button>
        </div>
      ) : (
        <Button
          size="lg"
          className="w-fit"
          onClick={() => setStage({ kind: "password" })}
        >
          Set up an authenticator app
        </Button>
      )}

      <Dialog
        open={stage.kind === "password"}
        onOpenChange={(open) => !open && setStage({ kind: "idle" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm your password</DialogTitle>
            <DialogDescription>
              Setting up a second factor starts with the first one.
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              enrol.mutate(
                String(new FormData(event.currentTarget).get("password") ?? "")
              )
            }}
          >
            <FieldGroup>
              {enrol.error !== null && (
                <FormAlert>{passwordMessage(enrol.error)}</FormAlert>
              )}
              <FormField
                id="enrol-password"
                name="password"
                type="password"
                label="Your password"
                autoComplete="current-password"
                required
                autoFocus
              />
              <Button type="submit" size="lg" disabled={enrol.isPending}>
                {enrol.isPending && <Spinner />}
                Continue
              </Button>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={stage.kind === "regenerate"}
        onOpenChange={(open) => !open && setStage({ kind: "idle" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New recovery codes</DialogTitle>
            <DialogDescription>
              The ten you have stop working. Enter a current code to continue.
            </DialogDescription>
          </DialogHeader>
          <FactorForm
            onSubmit={(proof) => regenerate.mutate(proof)}
            pending={regenerate.isPending}
            error={regenerate.error}
            submitLabel="Replace them"
            allowRecovery={false}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={stage.kind === "disable"}
        onOpenChange={(open) => !open && setStage({ kind: "idle" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication?</DialogTitle>
            <DialogDescription>
              Your password alone will sign you in again. Workspaces that
              require a second factor will ask you to set one up before they
              open. Using a recovery code here signs you out everywhere.
            </DialogDescription>
          </DialogHeader>
          <FactorForm
            onSubmit={(proof) => disable.mutate(proof)}
            pending={disable.isPending}
            error={disable.error}
            submitLabel="Turn off"
          />
        </DialogContent>
      </Dialog>
      {confirm.error !== null && stage.kind === "idle" && (
        <FormAlert>{factorMessage(confirm.error)}</FormAlert>
      )}
    </div>
  )
}

function passwordMessage(error: Error): string {
  if (error instanceof ApiError && error.type === "rate-limited")
    return "Too many wrong attempts. Try again later."
  if (error instanceof ApiError && error.status === 400)
    return "That password didn't match."
  return "Setting up didn't start. Try again in a moment."
}
