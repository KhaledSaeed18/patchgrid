"use client"

import {
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_TYPES,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { toast } from "sonner"

/** Active, off, or waiting out an open circuit: what an admin needs to know at a glance. */
export function EndpointStatus({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (endpoint.status === "DISABLED") return <Badge variant="destructive">Off</Badge>
  const open =
    endpoint.circuitOpenUntil !== null &&
    new Date(endpoint.circuitOpenUntil) > new Date()
  if (open) return <Badge variant="destructive">Paused after failures</Badge>
  if (endpoint.consecutiveFailures > 0) return <Badge variant="outline">Failing</Badge>
  return <Badge variant="outline">Active</Badge>
}

/** The catalogue as checkboxes, each with what it means. */
export function EventPicker({
  value,
  onChange,
}: {
  value: WebhookEventType[]
  onChange: (next: WebhookEventType[]) => void
}) {
  const toggle = (type: WebhookEventType) =>
    onChange(value.includes(type) ? value.filter((t) => t !== type) : [...value, type])
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Events</legend>
      {WEBHOOK_EVENT_TYPES.map((type) => (
        <label key={type} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={value.includes(type)}
            onChange={() => toggle(type)}
          />
          <span>
            {WEBHOOK_EVENT_DESCRIPTIONS[type]}{" "}
            <span className="font-mono text-xs text-muted-foreground">{type}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/** A signing secret, shown once: on creation and on rotation. */
export function SecretDialog({
  secret,
  rotated,
  onClose,
}: {
  secret: string | null
  rotated: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy the signing secret now</DialogTitle>
          <DialogDescription>
            This is the only time it is shown.{" "}
            {rotated
              ? "The previous secret keeps signing for 24 hours, so your receiver can switch without missing a request."
              : "Your receiver checks each request's webhook-signature header with it."}
          </DialogDescription>
        </DialogHeader>
        <code
          aria-label="Signing secret"
          className="block rounded-md border border-border bg-muted p-3 font-mono text-xs break-all select-all"
        >
          {secret}
        </code>
        <p className="text-xs text-muted-foreground">
          Requests follow the Standard Webhooks specification, so its libraries verify them. Deliveries can
          repeat: deduplicate on <span className="font-mono">webhook-id</span>.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              secret !== null &&
              void navigator.clipboard.writeText(secret).then(() => toast.success("Copied."))
            }
          >
            Copy
          </Button>
          <Button onClick={onClose}>I&apos;ve stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
