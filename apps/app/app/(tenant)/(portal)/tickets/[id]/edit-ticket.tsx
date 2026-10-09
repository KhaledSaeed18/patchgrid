"use client"

import {
  type Category,
  impactSchema,
  type Ticket,
  ticketSchema,
  type UpdateTicketRequest,
  urgencySchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@patchgrid/ui/components/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { categoryPath, inTreeOrder } from "@/lib/category-tree"
import { failureMessage } from "@/lib/failure"
import { IMPACT_LABEL, URGENCY_LABEL } from "@/lib/labels"

/**
 * Edit what the server says this actor may edit on this ticket
 * (`capabilities.editableFields`) — a requester their own while it is new,
 * an agent more. Sends only what changed, against the version on screen; if
 * someone got there first, that is a 409 and the page reloads.
 */
export function EditTicket({
  ticket,
  categories,
}: {
  ticket: Ticket
  categories: Category[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const editable = new Set(ticket.capabilities.editableFields)
  const options = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    return inTreeOrder(categories).map((c) => ({
      id: c.id,
      label: categoryPath(c, byId),
    }))
  }, [categories])

  const save = useMutation({
    mutationFn: (request: UpdateTicketRequest) =>
      clientApi(`/tickets/${ticket.id}`, {
        method: "PATCH",
        body: request,
        schema: ticketSchema,
      }),
    onSuccess: () => {
      toast.success("Ticket updated")
      setOpen(false)
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.type === "stale-write") {
        toast.error(
          "Someone else changed this ticket first. It has been reloaded."
        )
        setOpen(false)
        router.refresh()
      }
    },
  })
  const fieldError = (name: string) =>
    save.error instanceof ApiError ? save.error.fieldError(name) : undefined
  const formError =
    save.error !== null &&
    !(
      save.error instanceof ApiError &&
      (save.error.status === 400 || save.error.type === "stale-write")
    )
      ? failureMessage(save.error, "Your changes weren't saved.")
      : undefined

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>Edit</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {ticket.number}</DialogTitle>
          <DialogDescription>
            Changing who is affected or how urgent it is recalculates the
            priority and its deadlines.
          </DialogDescription>
        </DialogHeader>
        <form
          id="edit-ticket"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const text = (name: string) => String(data.get(name) ?? "").trim()
            const changes: Omit<UpdateTicketRequest, "version"> = {}
            if (editable.has("title") && text("title") !== ticket.title)
              changes.title = text("title")
            if (
              editable.has("description") &&
              text("description") !== ticket.description
            )
              changes.description = text("description")
            if (editable.has("impact")) {
              const impact = impactSchema.parse(data.get("impact"))
              if (impact !== ticket.impact) changes.impact = impact
            }
            if (editable.has("urgency")) {
              const urgency = urgencySchema.parse(data.get("urgency"))
              if (urgency !== ticket.urgency) changes.urgency = urgency
            }
            if (editable.has("categoryId")) {
              const categoryId = text("categoryId")
              const next = categoryId === "" ? null : categoryId
              if (next !== (ticket.category?.id ?? null))
                changes.categoryId = next
            }
            if (Object.keys(changes).length === 0) {
              setOpen(false)
              return
            }
            save.mutate({ version: ticket.version, ...changes })
          }}
        >
          <FieldGroup>
            {formError !== undefined && <FormAlert>{formError}</FormAlert>}
            {editable.has("title") && (
              <FormField
                id="edit-title"
                name="title"
                label="Title"
                defaultValue={ticket.title}
                maxLength={200}
                error={fieldError("title")}
              />
            )}
            {editable.has("description") && (
              <Field
                data-invalid={
                  fieldError("description") !== undefined ? true : undefined
                }
              >
                <FieldLabel htmlFor="edit-description">Details</FieldLabel>
                <Textarea
                  id="edit-description"
                  name="description"
                  rows={5}
                  defaultValue={ticket.description}
                />
                {fieldError("description") !== undefined && (
                  <FieldError>{fieldError("description")}</FieldError>
                )}
              </Field>
            )}
            {editable.has("impact") && (
              <Field>
                <FieldLabel htmlFor="edit-impact">Who is affected</FieldLabel>
                <NativeSelect
                  id="edit-impact"
                  name="impact"
                  defaultValue={ticket.impact}
                >
                  {impactSchema.options.map((v) => (
                    <option key={v} value={v}>
                      {IMPACT_LABEL[v]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {editable.has("urgency") && (
              <Field>
                <FieldLabel htmlFor="edit-urgency">
                  How much it stops them
                </FieldLabel>
                <NativeSelect
                  id="edit-urgency"
                  name="urgency"
                  defaultValue={ticket.urgency}
                >
                  {urgencySchema.options.map((v) => (
                    <option key={v} value={v}>
                      {URGENCY_LABEL[v]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {editable.has("categoryId") && (
              <Field>
                <FieldLabel htmlFor="edit-category">Category</FieldLabel>
                <NativeSelect
                  id="edit-category"
                  name="categoryId"
                  defaultValue={ticket.category?.id ?? ""}
                >
                  <option value="">None</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
                {fieldError("categoryId") !== undefined && (
                  <FieldError>{fieldError("categoryId")}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="submit" form="edit-ticket" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
