"use client"

import {
  factorAddedSchema,
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
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import {
  EnrolForm,
  FactorForm,
  factorMessage,
  type FactorProof,
} from "@/components/mfa/factor-form"
import {
  type HolderProof,
  HolderProofForm,
  PROOF_OPTIONS,
} from "@/components/mfa/holder-proof-form"
import { RecoveryCodes } from "@/components/mfa/recovery-codes"
import { clientApi } from "@/lib/api/client"
import { ROOT_DOMAIN } from "@/lib/config"

import { Passkeys } from "./passkeys"

type Stage =
  | { kind: "idle" }
  | { kind: "prove" }
  | { kind: "enrol"; enrolment: MfaEnrolment }
  | { kind: "recovery"; codes: string[] }
  | { kind: "regenerate" }
  | { kind: "disable" }

/**
 * A person's second factors, on the account rather than any workspace
 * (ADR-0029, ADR-0053): passkeys, an authenticator app, and the recovery
 * codes that outlive either. Every change is proved by a factor the person
 * already holds — the password only when they hold none — and the recovery
 * codes are shown exactly once.
 */
export function Security({ requiredBy }: { requiredBy: string | null }) {
  const queryClient = useQueryClient()
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const status = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => clientApi("/auth/mfa", { schema: mfaStatusSchema }),
  })
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["mfa-status"] })

  const enrol = useMutation({
    mutationFn: (proof: HolderProof) =>
      clientApi("/auth/mfa/enrol", {
        method: "POST",
        body: proof,
        schema: mfaEnrolmentSchema,
      }),
    onSuccess: (enrolment) => setStage({ kind: "enrol", enrolment }),
  })
  const confirm = useMutation({
    mutationFn: (code: string) =>
      clientApi("/auth/mfa/confirm", {
        method: "POST",
        body: { code },
        schema: factorAddedSchema,
      }),
    onSuccess: (result) => {
      void refresh()
      if (result.recoveryCodes !== null)
        setStage({ kind: "recovery", codes: result.recoveryCodes })
      else {
        setStage({ kind: "idle" })
        toast.success("Your authenticator app is set up.")
      }
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
      toast.success("Your authenticator app is off.")
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

  if (status.data === undefined) return <Spinner />
  const { methods, enrolled } = status.data
  const close = () => setStage({ kind: "idle" })
  return (
    <div className="grid gap-8">
      {requiredBy !== null && methods.length === 0 && (
        <FormAlert tone="info">
          <span className="font-mono">
            {requiredBy}.{ROOT_DOMAIN}
          </span>{" "}
          requires a second factor. Add a passkey or an authenticator app
          here, then open the workspace again.
        </FormAlert>
      )}

      <Passkeys
        methods={methods}
        onRecoveryCodes={(codes) => setStage({ kind: "recovery", codes })}
      />

      <section
        className="grid gap-4 border-t border-border pt-6"
        aria-labelledby="totp-heading"
      >
        <div className="grid gap-1 text-sm leading-relaxed">
          <h2 id="totp-heading" className="font-medium">
            Authenticator app{" "}
            <span className="font-normal text-muted-foreground">
              — {enrolled ? "on" : "off"}
              {enrolled &&
                status.data.confirmedAt !== null &&
                ` since ${new Date(status.data.confirmedAt).toLocaleDateString()}`}
            </span>
          </h2>
          <p className="text-muted-foreground">
            {enrolled
              ? "Signing in with your password also takes a code from your authenticator app."
              : "A code that changes every 30 seconds, asked for after your password, so a stolen password is not enough."}
          </p>
        </div>
        {enrolled ? (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => setStage({ kind: "disable" })}
          >
            Turn off
          </Button>
        ) : (
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => setStage({ kind: "prove" })}
          >
            Set up an authenticator app
          </Button>
        )}
      </section>

      {methods.length > 0 && (
        <section
          className="grid gap-4 border-t border-border pt-6"
          aria-labelledby="recovery-heading"
        >
          <div className="grid gap-1 text-sm leading-relaxed">
            <h2 id="recovery-heading" className="font-medium">
              Recovery codes
            </h2>
            <p className="text-muted-foreground">
              {String(status.data.recoveryCodesRemaining)} of 10 left. Each
              signs you in once if every device you use is lost.
            </p>
          </div>
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => setStage({ kind: "regenerate" })}
          >
            New recovery codes
          </Button>
        </section>
      )}

      <Dialog open={stage.kind === "prove"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm it&apos;s you</DialogTitle>
            <DialogDescription>
              Setting up a second factor starts with a proof you already hold.
            </DialogDescription>
          </DialogHeader>
          <HolderProofForm
            methods={methods}
            onSubmit={(proof) => enrol.mutate(proof)}
            allowRecovery={false}
            pending={enrol.isPending}
            error={enrol.error}
            submitLabel="Continue"
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={stage.kind === "regenerate"}
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New recovery codes</DialogTitle>
            <DialogDescription>
              The ones you have stop working. Confirm with a second factor to
              continue.
            </DialogDescription>
          </DialogHeader>
          <FactorForm
            methods={methods}
            passkeyOptions={PROOF_OPTIONS}
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
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off the authenticator app?</DialogTitle>
            <DialogDescription>
              Signing in will no longer ask for its code. If it is your only
              second factor, workspaces that require one will ask you to set
              one up before they open. Using a recovery code here signs you
              out everywhere.
            </DialogDescription>
          </DialogHeader>
          <FactorForm
            methods={methods}
            passkeyOptions={PROOF_OPTIONS}
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
