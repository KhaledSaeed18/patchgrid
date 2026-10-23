"use client"

import {
  type FactorMethod,
  type Passkey,
  passkeyCreationCeremonySchema,
  passkeyRegisteredSchema,
  passkeySchema,
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
import { FactorForm, type FactorProof } from "@/components/mfa/factor-form"
import {
  type HolderProof,
  HolderProofForm,
  PROOF_OPTIONS,
} from "@/components/mfa/holder-proof-form"
import { clientApi } from "@/lib/api/client"
import {
  createPasskey,
  PasskeyAlreadyRegistered,
  PasskeyCancelled,
  usePasskeysAvailable,
} from "@/lib/passkeys"

type Stage =
  | { kind: "idle" }
  | { kind: "name" }
  | { kind: "prove"; label: string }
  | { kind: "rename"; passkey: Passkey }
  | { kind: "remove"; passkey: Passkey }

const passkeyListSchema = passkeySchema.array()

/**
 * The person's passkeys (ADR-0053): each signs in alone, on every workspace
 * host. Adding one takes a fresh proof — a factor if they hold one, the
 * password only when they hold none — so a session alone cannot add a
 * credential of its own. Removing one takes a factor; renaming takes nothing.
 */
export function Passkeys({
  methods,
  onRecoveryCodes,
}: {
  methods: readonly FactorMethod[]
  onRecoveryCodes: (codes: string[]) => void
}) {
  const queryClient = useQueryClient()
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const available = usePasskeysAvailable()
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => clientApi("/auth/passkeys", { schema: passkeyListSchema }),
  })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
      queryClient.invalidateQueries({ queryKey: ["mfa-status"] }),
    ])
  const close = () => setStage({ kind: "idle" })

  const add = useMutation({
    mutationFn: async ({
      label,
      proof,
    }: {
      label: string
      proof: HolderProof
    }) => {
      const ceremony = await clientApi("/auth/passkeys/registration/options", {
        method: "POST",
        body: proof,
        schema: passkeyCreationCeremonySchema,
      })
      const credential = await createPasskey(ceremony)
      return clientApi("/auth/passkeys", {
        method: "POST",
        body: { challengeId: ceremony.challengeId, credential, label },
        schema: passkeyRegisteredSchema,
      })
    },
    onSuccess: (result) => {
      close()
      void refresh()
      if (result.recoveryCodes !== null) onRecoveryCodes(result.recoveryCodes)
      else toast.success(`Passkey “${result.passkey.label}” added.`)
    },
    onError: (error) => {
      if (error instanceof PasskeyCancelled) add.reset()
    },
  })
  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      clientApi(`/auth/passkeys/${id}`, {
        method: "PATCH",
        body: { label },
        schema: passkeySchema,
      }),
    onSuccess: () => {
      close()
      void refresh()
    },
  })
  const remove = useMutation({
    mutationFn: ({ id, proof }: { id: string; proof: FactorProof }) =>
      clientApi(`/auth/passkeys/${id}/remove`, {
        method: "POST",
        body: proof,
        schema: null,
      }),
    onSuccess: () => {
      close()
      toast.success("Passkey removed.")
      void refresh()
    },
  })

  const list = passkeys.data ?? []
  return (
    <section className="grid gap-4" aria-labelledby="passkeys-heading">
      <div className="grid gap-1 text-sm leading-relaxed">
        <h2 id="passkeys-heading" className="font-medium">
          Passkeys
        </h2>
        <p className="text-muted-foreground">
          A passkey signs you in with your device&apos;s fingerprint, face or
          PIN — no password, and nothing a phishing page can reuse.
        </p>
      </div>
      {passkeys.isPending ? (
        <Spinner />
      ) : list.length > 0 ? (
        <ul className="grid divide-y divide-border rounded-lg border border-border text-sm">
          {list.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="grid gap-0.5">
                <span className="font-medium">{passkey.label}</span>
                <span className="text-xs text-muted-foreground">
                  Added {new Date(passkey.createdAt).toLocaleDateString()}
                  {" · "}
                  {passkey.lastUsedAt === null
                    ? "never used"
                    : `last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`}
                  {passkey.synced && " · synced"}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStage({ kind: "rename", passkey })}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStage({ kind: "remove", passkey })}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {available ? (
        <Button
          variant={list.length > 0 ? "outline" : "default"}
          className="w-fit"
          onClick={() => setStage({ kind: "name" })}
        >
          Add a passkey
        </Button>
      ) : (
        <FormAlert tone="info">
          This browser can&apos;t create a passkey here: passkeys need a
          secure (HTTPS) connection.
        </FormAlert>
      )}

      <Dialog open={stage.kind === "name"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Name this passkey</DialogTitle>
            <DialogDescription>
              So you can tell it apart later — the device or password manager
              it lives in.
            </DialogDescription>
          </DialogHeader>
          <LabelForm
            initial="Passkey"
            submitLabel="Continue"
            pending={false}
            error={null}
            onSubmit={(label) => setStage({ kind: "prove", label })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={stage.kind === "prove"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm it&apos;s you</DialogTitle>
            <DialogDescription>
              A passkey signs you in on its own, so adding one takes a fresh
              proof. Your browser asks for the new passkey next.
            </DialogDescription>
          </DialogHeader>
          {add.error instanceof PasskeyAlreadyRegistered && (
            <FormAlert>
              This device already has a passkey for your account.
            </FormAlert>
          )}
          {stage.kind === "prove" && (
            <HolderProofForm
              methods={methods}
              onSubmit={(proof) => add.mutate({ label: stage.label, proof })}
              allowRecovery={false}
              pending={add.isPending}
              error={
                add.error instanceof PasskeyAlreadyRegistered ? null : add.error
              }
              submitLabel="Continue"
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={stage.kind === "rename"}
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename passkey</DialogTitle>
          </DialogHeader>
          {stage.kind === "rename" && (
            <LabelForm
              initial={stage.passkey.label}
              submitLabel="Save"
              pending={rename.isPending}
              error={rename.error}
              onSubmit={(label) =>
                rename.mutate({ id: stage.passkey.id, label })
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={stage.kind === "remove"}
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove {stage.kind === "remove" ? `“${stage.passkey.label}”` : ""}
              ?
            </DialogTitle>
            <DialogDescription>
              It will no longer sign you in. Confirm with a second factor —
              this passkey included.
            </DialogDescription>
          </DialogHeader>
          {stage.kind === "remove" && (
            <FactorForm
              methods={methods}
              passkeyOptions={PROOF_OPTIONS}
              onSubmit={(proof) =>
                remove.mutate({ id: stage.passkey.id, proof })
              }
              pending={remove.isPending}
              error={remove.error}
              submitLabel="Remove"
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function LabelForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  initial: string
  submitLabel: string
  pending: boolean
  error: Error | null
  onSubmit: (label: string) => void
}) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const label = String(
          new FormData(event.currentTarget).get("label") ?? ""
        ).trim()
        if (label !== "") onSubmit(label)
      }}
    >
      <FieldGroup>
        {error !== null && (
          <FormAlert>That name didn&apos;t save. Try again.</FormAlert>
        )}
        <FormField
          id="passkey-label"
          name="label"
          label="Name"
          defaultValue={initial}
          maxLength={64}
          required
          autoFocus
        />
        <Button type="submit" size="lg" disabled={pending}>
          {pending && <Spinner />}
          {submitLabel}
        </Button>
      </FieldGroup>
    </form>
  )
}
