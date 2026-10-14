"use client"

import {
  type AssetDetail,
  assetDetailSchema,
  assetStatusSchema,
  assetTypeSchema,
  memberPageSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL } from "@/lib/labels"

/**
 * An asset's fields, for adding one (`asset` absent) or editing one. An edit
 * sends only what changed; an emptied optional field is sent as `null`,
 * which clears it. The owner is any current member, requesters included —
 * they are who most devices belong to.
 */
export function AssetForm({
  asset,
  onSaved,
}: {
  asset?: AssetDetail
  onSaved: (saved: AssetDetail) => void
}) {
  const [idempotencyKey] = useState(newIdempotencyKey)
  const members = useQuery({
    queryKey: ["members", "owners"],
    queryFn: () =>
      clientApi("/members?limit=100", { schema: memberPageSchema }),
  })
  const owners = (members.data?.items ?? []).filter(
    (m) => m.status !== "REMOVED" && m.kind === "HUMAN"
  )
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      asset === undefined
        ? clientApi("/assets", {
            method: "POST",
            body,
            schema: assetDetailSchema,
            idempotencyKey,
          })
        : clientApi(`/assets/${asset.id}`, {
            method: "PATCH",
            body,
            schema: assetDetailSchema,
          }),
    onSuccess: onSaved,
  })
  const [missing, setMissing] = useState<string | undefined>()
  const fieldError = (name: string) =>
    save.error instanceof ApiError ? save.error.fieldError(name) : undefined
  const serialError =
    fieldError("serialNumber") ??
    (save.error instanceof ApiError && save.error.status === 409
      ? "Another asset already has that serial number."
      : undefined)
  const formError =
    save.error !== null &&
    !(
      save.error instanceof ApiError &&
      (save.error.status === 400 || save.error.status === 409)
    )
      ? failureMessage(save.error, "The asset wasn't saved. Try again.")
      : undefined

  return (
    <form
      id="asset-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const text = (name: string) => String(data.get(name) ?? "").trim()
        const name = text("name")
        setMissing(
          name === "" ? "Give it a name people will recognise." : undefined
        )
        if (name === "") return
        const fields: Record<string, string | null> = {
          name,
          type: text("type"),
          status: text("status"),
          serialNumber: text("serialNumber") || null,
          ownerMembershipId: text("ownerMembershipId") || null,
          purchaseDate: text("purchaseDate") || null,
          warrantyExpiresAt: text("warrantyExpiresAt") || null,
          notes: text("notes") || null,
        }
        if (asset === undefined) {
          // A create leaves out what is empty rather than sending nulls.
          save.mutate(
            Object.fromEntries(
              Object.entries(fields).filter(([, v]) => v !== null)
            )
          )
          return
        }
        const before: Record<string, string | null> = {
          name: asset.name,
          type: asset.type,
          status: asset.status,
          serialNumber: asset.serialNumber,
          ownerMembershipId: asset.owner?.membershipId ?? null,
          purchaseDate: asset.purchaseDate,
          warrantyExpiresAt: asset.warrantyExpiresAt,
          notes: asset.notes,
        }
        const changed = Object.fromEntries(
          Object.entries(fields).filter(([k, v]) => before[k] !== v)
        )
        if (Object.keys(changed).length === 0) onSaved(asset)
        else save.mutate(changed)
      }}
    >
      <FieldGroup>
        {formError !== undefined && <FormAlert>{formError}</FormAlert>}
        <FormField
          id="asset-name"
          name="name"
          label="Name"
          placeholder="ThinkPad T14 — Rita"
          defaultValue={asset?.name}
          maxLength={120}
          required
          autoFocus
          error={missing ?? fieldError("name")}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="asset-type">Type</FieldLabel>
            <NativeSelect
              id="asset-type"
              name="type"
              defaultValue={asset?.type ?? "LAPTOP"}
            >
              {assetTypeSchema.options.map((t) => (
                <option key={t} value={t}>
                  {ASSET_TYPE_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="asset-status">Status</FieldLabel>
            <NativeSelect
              id="asset-status"
              name="status"
              defaultValue={asset?.status ?? "IN_STOCK"}
            >
              {assetStatusSchema.options.map((s) => (
                <option key={s} value={s}>
                  {ASSET_STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="asset-serial"
            name="serialNumber"
            label="Serial number"
            defaultValue={asset?.serialNumber ?? ""}
            maxLength={100}
            className="font-mono"
            error={serialError}
          />
          <Field>
            <FieldLabel htmlFor="asset-owner">Who has it</FieldLabel>
            <NativeSelect
              id="asset-owner"
              name="ownerMembershipId"
              defaultValue={asset?.owner?.membershipId ?? ""}
              disabled={members.isPending}
            >
              <option value="">Nobody</option>
              {/* Until the list arrives, the current owner is still a choice. */}
              {asset?.owner != null &&
                !owners.some((m) => m.id === asset.owner?.membershipId) && (
                  <option value={asset.owner.membershipId}>
                    {asset.owner.displayName}
                  </option>
                )}
              {owners.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="asset-purchased"
            name="purchaseDate"
            type="date"
            label="Purchased"
            defaultValue={asset?.purchaseDate ?? ""}
            error={fieldError("purchaseDate")}
          />
          <FormField
            id="asset-warranty"
            name="warrantyExpiresAt"
            type="date"
            label="Warranty ends"
            defaultValue={asset?.warrantyExpiresAt ?? ""}
            error={fieldError("warrantyExpiresAt")}
          />
        </div>
        <Field data-invalid={fieldError("notes") ? true : undefined}>
          <FieldLabel htmlFor="asset-notes">Notes</FieldLabel>
          <Textarea
            id="asset-notes"
            name="notes"
            rows={3}
            maxLength={2000}
            defaultValue={asset?.notes ?? ""}
          />
          {fieldError("notes") !== undefined && (
            <FieldError>{fieldError("notes")}</FieldError>
          )}
        </Field>
        <div>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {asset === undefined ? "Add asset" : "Save changes"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}
