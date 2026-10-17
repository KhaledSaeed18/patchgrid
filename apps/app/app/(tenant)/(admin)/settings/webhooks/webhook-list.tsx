"use client"

import {
  createdWebhookEndpointSchema,
  MAX_WEBHOOK_ENDPOINTS,
  type WebhookEndpoint,
  type WebhookEventType,
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
import { Field, FieldLabel } from "@patchgrid/ui/components/field"
import { Input } from "@patchgrid/ui/components/input"
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
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

import { EndpointStatus, EventPicker, SecretDialog } from "./webhook-parts"

/**
 * The workspace's webhook endpoints (ADR-0050): where each sends, what it
 * listens for, and whether it is healthy. A new endpoint's secret is shown
 * once, in the dialog that follows its creation.
 */
export function WebhookList({ initial }: { initial: WebhookEndpoint[] }) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const full = initial.length >= MAX_WEBHOOK_ENDPOINTS

  return (
    <div className="px-6 py-6 md:px-10">
      <Button disabled={full} onClick={() => setAdding(true)}>
        Add webhook
      </Button>
      {full && (
        <p className="mt-2 text-xs text-muted-foreground">
          A workspace has at most {MAX_WEBHOOK_ENDPOINTS} webhooks.
        </p>
      )}
      {initial.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No webhooks yet. Add one to tell a chat channel, a status page or your own service when tickets
          change.
        </p>
      ) : (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Sends to</TableHead>
              <TableHead>Listens for</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((endpoint) => (
              <TableRow key={endpoint.id} className={endpoint.status === "ACTIVE" ? undefined : "opacity-60"}>
                <TableCell>
                  <Link href={`/settings/webhooks/${endpoint.id}`} className="font-mono text-xs break-all hover:underline">
                    {endpoint.url}
                  </Link>
                  {endpoint.description !== null && (
                    <p className="text-xs text-muted-foreground">{endpoint.description}</p>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {endpoint.eventTypes.length === 1
                    ? endpoint.eventTypes[0]
                    : `${String(endpoint.eventTypes.length)} events`}
                </TableCell>
                <TableCell>
                  <EndpointStatus endpoint={endpoint} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(value) => {
          setAdding(false)
          setSecret(value)
          router.refresh()
        }}
      />
      <SecretDialog secret={secret} rotated={false} onClose={() => setSecret(null)} />
    </div>
  )
}

function AddDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: (secret: string) => void
}) {
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [events, setEvents] = useState<WebhookEventType[]>(["ticket.created"])
  const add = useMutation({
    mutationFn: () =>
      clientApi("/org/webhooks", {
        method: "POST",
        body: {
          url: url.trim(),
          ...(description.trim() === "" ? {} : { description: description.trim() }),
          eventTypes: events,
        },
        schema: createdWebhookEndpointSchema,
      }),
    onSuccess: (created) => {
      setUrl("")
      setDescription("")
      setEvents(["ticket.created"])
      onAdded(created.secret)
    },
    onError: (error) => toast.error(failureMessage(error, "The webhook wasn't added.")),
  })

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a webhook</DialogTitle>
          <DialogDescription>
            Patchgrid POSTs a small JSON body to this address whenever one of the chosen events happens. It must
            be a public https address.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="webhook-url">URL</FieldLabel>
            <Input
              id="webhook-url"
              value={url}
              type="url"
              placeholder="https://hooks.example.com/patchgrid"
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="webhook-description">Description (optional)</FieldLabel>
            <Input
              id="webhook-description"
              value={description}
              maxLength={200}
              placeholder="Posts new incidents to #it-alerts"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <EventPicker value={events} onChange={setEvents} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={add.isPending || url.trim() === "" || events.length === 0} onClick={() => add.mutate()}>
            {add.isPending && <Spinner />}
            Add webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
