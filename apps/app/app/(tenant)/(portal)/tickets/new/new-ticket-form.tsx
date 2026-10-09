"use client"

import {
  type Category,
  type CreateTicketRequest,
  type Impact,
  impactSchema,
  ticketSchema,
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
import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { categoryPath, inTreeOrder } from "@/lib/category-tree"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"
import { IMPACT_LABEL, URGENCY_LABEL } from "@/lib/labels"

/**
 * The portal's incident form. There is no priority field, on purpose: the
 * server computes it from impact × urgency (DOMAIN.md §3) and refuses one
 * sent by a client. People answer two questions they can actually answer.
 */
export function NewTicketForm({ categories }: { categories: Category[] }) {
  const router = useRouter()
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
          type: "INCIDENT",
          title,
          description,
          impact: impactSchema.parse(data.get("impact")),
          urgency: urgencySchema.parse(data.get("urgency")),
          ...(categoryId === "" ? {} : { categoryId }),
        })
      }}
    >
      <FieldGroup>
        {formError !== undefined && <FormAlert>{formError}</FormAlert>}
        <FormField
          id="ticket-title"
          name="title"
          label="What's wrong, in a few words"
          placeholder="Printer on floor 3 says it's offline"
          maxLength={200}
          required
          autoFocus
          error={fieldError("title")}
        />
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
        <div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Raise ticket
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
