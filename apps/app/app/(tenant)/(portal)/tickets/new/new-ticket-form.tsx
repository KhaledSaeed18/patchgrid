"use client"

import {
  type Category,
  type ChangeRisk,
  changeRiskSchema,
  type CreateTicketRequest,
  type Impact,
  impactSchema,
  type LinkedAsset,
  MAX_TICKET_ASSETS,
  ticketSchema,
  type TicketType,
  type Urgency,
  urgencySchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { cn } from "@patchgrid/ui/lib/utils"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { useTenant } from "@/components/tenant-provider"
import { AssetPicker } from "@/components/assets/asset-picker"
import { ArticleSuggestions } from "@/components/knowledge/article-suggestions"
import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { categoryPath, inTreeOrder } from "@/lib/category-tree"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"
import {
  IMPACT_LABEL,
  RISK_LABEL,
  TICKET_TYPE_LABEL,
  URGENCY_LABEL,
} from "@/lib/labels"

/** What a create may carry over from the ticket it was raised from. */
export type RaisedFrom =
  | { kind: "incident"; id: string; number: string }
  | { kind: "problem"; id: string; number: string }
  | null

/**
 * One form for every type. There is no priority field, on purpose: the
 * server computes it from impact × urgency (DOMAIN.md §3) and refuses one
 * sent by a client. The types on offer are `/me`'s `creatableTypes` — a
 * requester sees incidents and requests, an agent all four — and a Problem
 * or Change adds its own fields, every one optional until the work needs it.
 */
export function NewTicketForm({
  categories,
  initialType,
  raisedFrom,
  offerAssets,
}: {
  categories: Category[]
  initialType: TicketType
  raisedFrom: RaisedFrom
  /** Whether there is any asset this member could name — a requester with none is not asked. */
  offerAssets: boolean
}) {
  const router = useRouter()
  const { creatableTypes, holds } = useTenant()
  const [assets, setAssets] = useState<LinkedAsset[]>([])
  const [title, setTitle] = useState("")
  const [type, setType] = useState<TicketType>(
    creatableTypes.includes(initialType)
      ? initialType
      : (creatableTypes[0] ?? "INCIDENT")
  )
  // One key per form: a double submit or a retry after a dropped response
  // replays the first ticket instead of raising a second.
  const [idempotencyKey] = useState(newIdempotencyKey)
  const options = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    return inTreeOrder(categories).map((c) => ({
      id: c.id,
      label: categoryPath(c, byId),
    }))
  }, [categories])

  const create = useMutation({
    mutationFn: (request: CreateTicketRequest) =>
      clientApi("/tickets", {
        method: "POST",
        body: request,
        schema: ticketSchema,
        idempotencyKey,
      }),
    onSuccess: (ticket) => router.push(`/tickets/${ticket.id}`),
  })
  // Empty fields are caught here, in words; everything else is the server's answer.
  const [missing, setMissing] = useState<Record<string, string>>({})
  const fieldError = (name: string) =>
    missing[name] ??
    (create.error instanceof ApiError
      ? create.error.fieldError(name)
      : undefined)
  const formError =
    create.error !== null &&
    !(create.error instanceof ApiError && create.error.status === 400)
      ? failureMessage(create.error, "Your ticket wasn't raised. Try again.")
      : undefined

  return (
    <form
      noValidate
      className="max-w-2xl px-6 py-8 md:px-10"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const categoryId = String(data.get("categoryId") ?? "")
        const title = String(data.get("title") ?? "").trim()
        const description = String(data.get("description") ?? "").trim()
        const empty: Record<string, string> = {}
        if (title === "") empty.title = "Say what's wrong in a few words."
        if (description === "")
          empty.description = "Add a few details so the team can start."
        setMissing(empty)
        if (Object.keys(empty).length > 0) return
        create.mutate({
          type,
          title,
          description,
          impact: impactSchema.parse(data.get("impact")),
          urgency: urgencySchema.parse(data.get("urgency")),
          ...(categoryId === "" ? {} : { categoryId }),
          ...(assets.length === 0 ? {} : { assetIds: assets.map((a) => a.id) }),
          ...extrasFor(type, data, raisedFrom),
        })
      }}
    >
      <FieldGroup>
        {formError !== undefined && <FormAlert>{formError}</FormAlert>}
        {creatableTypes.length > 1 && (
          <FieldSet>
            <FieldLegend variant="label">What kind of ticket</FieldLegend>
            <div
              className={cn(
                "grid gap-2",
                creatableTypes.length > 2 ? "sm:grid-cols-4" : "sm:grid-cols-2"
              )}
            >
              {creatableTypes.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm",
                    "has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
                  )}
                >
                  <input
                    type="radio"
                    name="type"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                    className="accent-primary"
                  />
                  {TICKET_TYPE_LABEL[value]}
                </label>
              ))}
            </div>
          </FieldSet>
        )}
        {raisedFrom !== null && (
          <p className="text-sm text-muted-foreground">
            {raisedFrom.kind === "incident"
              ? `${raisedFrom.number} will be linked as caused by this problem.`
              : `This change will be linked as resolving ${raisedFrom.number}.`}
          </p>
        )}
        <FormField
          id="ticket-title"
          name="title"
          label="What's wrong, in a few words"
          placeholder="Printer on floor 3 says it's offline"
          maxLength={200}
          required
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          error={fieldError("title")}
        />
        {(type === "INCIDENT" || type === "SERVICE_REQUEST") && (
          <ArticleSuggestions title={title} />
        )}
        <Field data-invalid={fieldError("description") ? true : undefined}>
          <FieldLabel htmlFor="ticket-description">Details</FieldLabel>
          <Textarea
            id="ticket-description"
            name="description"
            rows={6}
            required
            placeholder="What you were doing, what happened, and anything you've already tried."
            aria-invalid={fieldError("description") ? true : undefined}
          />
          {fieldError("description") !== undefined && (
            <FieldError>{fieldError("description")}</FieldError>
          )}
        </Field>
        {options.length > 0 && (
          <Field>
            <FieldLabel htmlFor="ticket-category">
              What it&apos;s about
            </FieldLabel>
            <NativeSelect
              id="ticket-category"
              name="categoryId"
              defaultValue=""
            >
              <option value="">Not sure</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
            <FieldDescription>
              Picking one gets it to the right team sooner.
            </FieldDescription>
          </Field>
        )}
        {offerAssets && (
          <Field data-invalid={fieldError("assetIds") ? true : undefined}>
            <FieldLabel>Which device or system, if any</FieldLabel>
            {assets.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {assets.map((asset) => (
                  <li
                    key={asset.id}
                    className="flex items-center gap-1 rounded-md border border-input px-2 py-1 text-sm"
                  >
                    {asset.name}
                    <button
                      type="button"
                      aria-label={`Remove ${asset.name}`}
                      onClick={() =>
                        setAssets((all) => all.filter((a) => a.id !== asset.id))
                      }
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {assets.length < MAX_TICKET_ASSETS && (
              <AssetPicker
                label="Which device or system"
                exclude={assets.map((a) => a.id)}
                browse={!holds("asset:read_all")}
                onPick={(asset) => setAssets((all) => [...all, asset])}
              />
            )}
            {fieldError("assetIds") !== undefined && (
              <FieldError>{fieldError("assetIds")}</FieldError>
            )}
          </Field>
        )}
        <Choice<Impact>
          name="impact"
          legend="Who is affected?"
          values={["LOW", "MEDIUM", "HIGH"]}
          labels={IMPACT_LABEL}
          initial="LOW"
        />
        <Choice<Urgency>
          name="urgency"
          legend="How much is it stopping you?"
          values={["LOW", "MEDIUM", "HIGH"]}
          labels={URGENCY_LABEL}
          initial="MEDIUM"
        />
        {type === "PROBLEM" && (
          <TextField
            name="workaround"
            label="Workaround, if there is one"
            hint="People hitting it can use this while the root cause is found."
          />
        )}
        {type === "CHANGE" && <ChangePlan />}
        <div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            {type === "CHANGE" ? "Save as draft" : "Raise ticket"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

/** A row of native radios styled as segments: arrow keys, labels and forms work as the platform made them. */
function Choice<T extends string>({
  name,
  legend,
  values,
  labels,
  initial,
}: {
  name: string
  legend: string
  values: readonly T[]
  labels: Record<T, string>
  initial: T
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="grid gap-2 sm:grid-cols-3">
        {values.map((value) => (
          <label
            key={value}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-lg border border-input px-3 py-2 text-sm",
              "has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
            )}
          >
            <input
              type="radio"
              name={name}
              value={value}
              defaultChecked={value === initial}
              className="accent-primary"
            />
            {labels[value]}
          </label>
        ))}
      </div>
    </FieldSet>
  )
}

/**
 * A Change's plan (DOMAIN.md §2.3). All optional now — it is saved as a
 * draft — and all required before it can be submitted for approval.
 */
function ChangePlan() {
  return (
    <FieldSet>
      <FieldLegend variant="label">The plan</FieldLegend>
      <FieldDescription>
        Saved as a draft. Everything here is needed before it can go for
        approval.
      </FieldDescription>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="plannedStart">Window opens</FieldLabel>
          <input
            id="plannedStart"
            name="plannedStart"
            type="datetime-local"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="plannedEnd">Window closes</FieldLabel>
          <input
            id="plannedEnd"
            name="plannedEnd"
            type="datetime-local"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="risk">Risk</FieldLabel>
        <NativeSelect id="risk" name="risk" defaultValue="">
          <option value="">Not assessed yet</option>
          {changeRiskSchema.options.map((risk: ChangeRisk) => (
            <option key={risk} value={risk}>
              {RISK_LABEL[risk]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <TextField name="implementationPlan" label="How it will be done" />
      <TextField
        name="rollbackPlan"
        label="How it will be undone if it goes wrong"
      />
    </FieldSet>
  )
}

function TextField({
  name,
  label,
  hint,
}: {
  name: string
  label: string
  hint?: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Textarea id={name} name={name} rows={3} />
      {hint !== undefined && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  )
}

/** The type's own fields and the link a "create from" carries; blanks are left out, not sent empty. */
function extrasFor(
  type: TicketType,
  data: FormData,
  raisedFrom: RaisedFrom
): Partial<CreateTicketRequest> {
  const text = (name: string) => {
    const value = String(data.get(name) ?? "").trim()
    return value === "" ? undefined : value
  }
  const when = (name: string) => {
    const value = text(name)
    return value === undefined ? undefined : new Date(value).toISOString()
  }
  if (type === "PROBLEM") {
    const workaround = text("workaround")
    return {
      ...(workaround === undefined ? {} : { problem: { workaround } }),
      ...(raisedFrom?.kind === "incident"
        ? { causedIncidentIds: [raisedFrom.id] }
        : {}),
    }
  }
  if (type === "CHANGE") {
    const risk = changeRiskSchema.safeParse(text("risk"))
    const fields = {
      plannedStart: when("plannedStart"),
      plannedEnd: when("plannedEnd"),
      risk: risk.success ? risk.data : undefined,
      implementationPlan: text("implementationPlan"),
      rollbackPlan: text("rollbackPlan"),
    }
    const change = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    )
    return {
      ...(Object.keys(change).length === 0 ? {} : { change }),
      ...(raisedFrom?.kind === "problem"
        ? { resolvesProblemId: raisedFrom.id }
        : {}),
    }
  }
  return {}
}
