"use client"

import {
  type Priority,
  type SlaPolicy,
  slaPolicySchema,
  type TicketType,
  updateSlaPolicyRequestSchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { FormField } from "@/components/form-field"
import { Section } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { formatDuration, parseDuration } from "@/lib/duration"
import { failureMessage } from "@/lib/failure"
import { PRIORITY_LABEL, TICKET_TYPE_LABEL } from "@/lib/labels"

const PRIORITY_ORDER: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
const TYPES: { type: TicketType; description: string }[] = [
  {
    type: "INCIDENT",
    description:
      "Something is broken. The clock pauses while a ticket waits on the requester.",
  },
  {
    type: "SERVICE_REQUEST",
    description: "Someone needs something new. Often looser than incidents.",
  },
]

type Field =
  | "responseTargetMinutes"
  | "responseWarningMinutes"
  | "resolutionTargetMinutes"
  | "resolutionWarningMinutes"

export function SlaTargets({ initial }: { initial: SlaPolicy[] }) {
  const { holds } = useTenant()
  const canWrite = holds("sla:write")
  const [editing, setEditing] = useState<SlaPolicy | null>(null)

  return (
    <>
      {TYPES.map(({ type, description }) => {
        const policies = PRIORITY_ORDER.flatMap(
          (priority) =>
            initial.find(
              (p) => p.ticketType === type && p.priority === priority
            ) ?? []
        )
        return (
          <Section
            key={type}
            title={`${TICKET_TYPE_LABEL[type]}s`}
            description={description}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead>First response</TableHead>
                  <TableHead>Resolution</TableHead>
                  {canWrite && (
                    <TableHead className="w-0">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.map((policy) => (
                  <TableRow key={policy.id}>
                    <TableCell className="font-medium">
                      {PRIORITY_LABEL[policy.priority]}
                    </TableCell>
                    <TableCell>
                      <Target
                        target={policy.responseTargetMinutes}
                        warning={policy.responseWarningMinutes}
                      />
                    </TableCell>
                    <TableCell>
                      <Target
                        target={policy.resolutionTargetMinutes}
                        warning={policy.resolutionWarningMinutes}
                      />
                    </TableCell>
                    {canWrite && (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(policy)}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )
      })}
      {editing !== null && (
        <EditTargets
          key={editing.id}
          policy={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function Target({ target, warning }: { target: number; warning: number }) {
  return (
    <>
      <span className="tabular-nums">{formatDuration(target)}</span>
      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
        warn {formatDuration(warning)} before
      </span>
    </>
  )
}

function EditTargets({
  policy,
  onClose,
}: {
  policy: SlaPolicy
  onClose: () => void
}) {
  const router = useRouter()
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const save = useMutation({
    mutationFn: (body: Record<Field, number>) =>
      clientApi(`/sla-policies/${policy.id}`, {
        method: "PATCH",
        body,
        schema: slaPolicySchema,
      }),
    onSuccess: () => {
      toast.success(
        `${PRIORITY_LABEL[policy.priority]} ${TICKET_TYPE_LABEL[policy.ticketType].toLowerCase()} targets saved`
      )
      onClose()
      router.refresh()
    },
  })
  const serverError = (field: Field) =>
    save.error instanceof ApiError ? save.error.fieldError(field) : undefined
  const errorFor = (field: Field) => errors[field] ?? serverError(field)
  const otherError =
    save.error !== null &&
    !(save.error instanceof ApiError && save.error.status === 400)
      ? failureMessage(save.error, "Those targets weren't saved.")
      : undefined

  const fields: { name: Field; label: string; description: string }[] = [
    {
      name: "responseTargetMinutes",
      label: "First response within",
      description:
        "A public reply from an agent, or resolving it, stops this clock.",
    },
    {
      name: "responseWarningMinutes",
      label: "Warn this long before",
      description: "Shorter than the response target.",
    },
    {
      name: "resolutionTargetMinutes",
      label: "Resolve within",
      description: "Time waiting on the requester doesn't count.",
    },
    {
      name: "resolutionWarningMinutes",
      label: "Warn this long before",
      description: "Shorter than the resolution target.",
    },
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {PRIORITY_LABEL[policy.priority]}{" "}
            {TICKET_TYPE_LABEL[policy.ticketType].toLowerCase()} targets
          </DialogTitle>
          <DialogDescription>
            Write durations like 30m, 4h or 2d 12h. Open tickets keep the
            targets they started with.
          </DialogDescription>
        </DialogHeader>
        <form
          id="sla-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const next: Partial<Record<Field, string>> = {}
            const values: Partial<Record<Field, number>> = {}
            for (const { name } of fields) {
              const minutes = parseDuration(String(data.get(name) ?? ""))
              if (minutes === null)
                next[name] = "Write a duration like 45m or 4h."
              else values[name] = minutes
            }
            const parsed = updateSlaPolicyRequestSchema.safeParse(values)
            if (Object.keys(next).length === 0 && !parsed.success) {
              for (const issue of parsed.error.issues) {
                const name = issue.path[0] as Field
                next[name] ??= "Must be shorter than the target above."
              }
            }
            setErrors(next)
            if (Object.keys(next).length === 0 && parsed.success) {
              save.mutate(parsed.data)
            }
          }}
        >
          <FieldGroup>
            {fields.map((field) => (
              <FormField
                key={field.name}
                id={`sla-${field.name}`}
                name={field.name}
                label={field.label}
                description={field.description}
                defaultValue={formatDuration(policy[field.name])}
                error={errorFor(field.name)}
              />
            ))}
          </FieldGroup>
        </form>
        {otherError !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {otherError}
          </p>
        )}
        <DialogFooter>
          <Button type="submit" form="sla-form" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            Save targets
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
