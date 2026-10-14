"use client"

import {
  type ChangeRisk,
  changeRiskSchema,
  type EditableField,
  type Ticket,
  ticketSchema,
  type UpdateTicketRequest,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/native-select"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { RISK_LABEL } from "@/lib/labels"

type DetailField = Exclude<
  EditableField,
  "title" | "description" | "impact" | "urgency" | "categoryId"
>

const LABEL: Record<DetailField, string> = {
  rootCause: "Root cause",
  workaround: "Workaround",
  plannedStart: "Window opens",
  plannedEnd: "Window closes",
  risk: "Risk",
  implementationPlan: "How it will be done",
  rollbackPlan: "How it will be undone",
  outcomeNotes: "Outcome",
}
const TEXT: readonly DetailField[] = [
  "rootCause",
  "workaround",
  "implementationPlan",
  "rollbackPlan",
  "outcomeNotes",
]

/**
 * A Problem's analysis or a Change's plan, outcome and decisions. What may be
 * edited, field by field, is the server's `editableFields` — a Change's plan
 * only while it is a draft, its outcome once approved — never worked out
 * here from its status.
 */
export function RecordDetails({ ticket }: { ticket: Ticket }) {
  const editable = ticket.capabilities.editableFields.filter(
    (f): f is DetailField => f in LABEL
  )
  if (ticket.problem !== null) {
    const p = ticket.problem
    return (
      <section className="mt-6 rounded-lg border border-border p-4">
        <Header title="Analysis" ticket={ticket} editable={editable} />
        <dl className="mt-3 grid gap-4 text-sm">
          <Item label="Workaround" value={p.workaround} empty="None yet" />
          <Item label="Root cause" value={p.rootCause} empty="Not found yet" />
          {p.knownErrorAt !== null && (
            <div className="text-muted-foreground">
              A known error since <RelativeTime at={p.knownErrorAt} />
            </div>
          )}
        </dl>
      </section>
    )
  }
  if (ticket.change === null) return null
  const c = ticket.change
  return (
    <section className="mt-6 rounded-lg border border-border p-4">
      <Header title="The plan" ticket={ticket} editable={editable} />
      <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
        <Item
          label="Window opens"
          value={when(c.plannedStart)}
          empty="Not set"
        />
        <Item
          label="Window closes"
          value={when(c.plannedEnd)}
          empty="Not set"
        />
        <Item
          label="Risk"
          value={c.risk === null ? null : RISK_LABEL[c.risk]}
          empty="Not assessed"
        />
      </dl>
      <dl className="mt-4 grid gap-4 text-sm">
        <Item
          label="How it will be done"
          value={c.implementationPlan}
          empty="Not written"
        />
        <Item
          label="How it will be undone"
          value={c.rollbackPlan}
          empty="Not written"
        />
        {(c.outcomeNotes !== null || editable.includes("outcomeNotes")) && (
          <Item label="Outcome" value={c.outcomeNotes} empty="Not recorded" />
        )}
      </dl>
      {c.approvals.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Decisions</h3>
          <ol className="mt-2 grid gap-2 text-sm">
            {c.approvals.map((a) => (
              <li key={a.id} className="rounded-md bg-muted/50 px-3 py-2">
                <span className="font-medium">
                  {a.decision === "APPROVED" ? "Approved" : "Rejected"}
                </span>{" "}
                by {a.approver.displayName} <RelativeTime at={a.decidedAt} />
                {a.selfApproved && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                    Self-approved — nobody else could
                  </span>
                )}
                {a.reason !== null && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {a.reason}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function Header({
  title,
  ticket,
  editable,
}: {
  title: string
  ticket: Ticket
  editable: DetailField[]
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {editable.length > 0 && (
        <EditDetails key={ticket.version} ticket={ticket} fields={editable} />
      )}
    </div>
  )
}

function Item({
  label,
  value,
  empty,
}: {
  label: string
  value: string | null
  empty: string
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap">
        {value ?? <span className="text-muted-foreground">{empty}</span>}
      </dd>
    </div>
  )
}

function when(iso: string | null): string | null {
  return iso === null
    ? null
    : new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
}

/** `datetime-local` speaks local time without a zone; the wire speaks UTC. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return ""
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

/** Edits exactly the detail fields the server named, against the version on screen. */
function EditDetails({
  ticket,
  fields,
}: {
  ticket: Ticket
  fields: DetailField[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (request: UpdateTicketRequest) =>
      clientApi(`/tickets/${ticket.id}`, {
        method: "PATCH",
        body: request,
        schema: ticketSchema,
      }),
    onSuccess: () => {
      setOpen(false)
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.type === "stale-write") {
        toast.error("Someone else changed this ticket. It has been reloaded.")
        setOpen(false)
        router.refresh()
      } else if (!(error instanceof ApiError && error.status === 400)) {
        toast.error(failureMessage(error, "Your changes weren't saved."))
      }
    },
  })
  const current = (field: DetailField): string => {
    if (
      ticket.problem !== null &&
      (field === "rootCause" || field === "workaround")
    )
      return ticket.problem[field] ?? ""
    if (ticket.change === null) return ""
    if (field === "plannedStart" || field === "plannedEnd")
      return toLocalInput(ticket.change[field])
    if (field === "risk") return ticket.change.risk ?? ""
    if (field === "rootCause" || field === "workaround") return ""
    return ticket.change[field] ?? ""
  }
  const fieldError = (field: DetailField) =>
    save.error instanceof ApiError
      ? (save.error.fieldError(`change.${field}`) ??
        save.error.fieldError(`problem.${field}`))
      : undefined

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {ticket.problem !== null
                ? "Edit the analysis"
                : "Edit the change"}
            </DialogTitle>
          </DialogHeader>
          <form
            id="edit-details"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              const changed: Record<string, string | null> = {}
              for (const field of fields) {
                const raw = String(data.get(field) ?? "").trim()
                if (raw === current(field)) continue
                if (field === "plannedStart" || field === "plannedEnd")
                  changed[field] =
                    raw === "" ? null : new Date(raw).toISOString()
                else if (field === "risk")
                  changed[field] = changeRiskSchema.safeParse(raw).success
                    ? raw
                    : null
                else changed[field] = raw === "" ? null : raw
              }
              if (Object.keys(changed).length === 0) {
                setOpen(false)
                return
              }
              save.mutate({
                version: ticket.version,
                ...(ticket.problem !== null
                  ? { problem: changed }
                  : { change: changed }),
              } as UpdateTicketRequest)
            }}
          >
            <FieldGroup>
              {fields.map((field) => (
                <Field
                  key={field}
                  data-invalid={fieldError(field) ? true : undefined}
                >
                  <FieldLabel htmlFor={`detail-${field}`}>
                    {LABEL[field]}
                  </FieldLabel>
                  {TEXT.includes(field) ? (
                    <Textarea
                      id={`detail-${field}`}
                      name={field}
                      rows={3}
                      defaultValue={current(field)}
                    />
                  ) : field === "risk" ? (
                    <NativeSelect
                      id={`detail-${field}`}
                      name={field}
                      defaultValue={current(field)}
                    >
                      <option value="">Not assessed</option>
                      {changeRiskSchema.options.map((risk: ChangeRisk) => (
                        <option key={risk} value={risk}>
                          {RISK_LABEL[risk]}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <input
                      id={`detail-${field}`}
                      name={field}
                      type="datetime-local"
                      defaultValue={current(field)}
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    />
                  )}
                  {fieldError(field) !== undefined && (
                    <FieldError>{fieldError(field)}</FieldError>
                  )}
                </Field>
              ))}
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button type="submit" form="edit-details" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
