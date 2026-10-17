"use client"

import {
  type Page,
  type WebhookDelivery,
  webhookDeliveryPageSchema,
  type WebhookDeliveryStatus,
  webhookDeliveryStatusSchema,
  type WebhookEndpoint,
  webhookEndpointSchema,
  type WebhookEventType,
  webhookSecretSchema,
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
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/native-select"
import { PageHeader } from "@/components/page-header"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

import { EndpointStatus, EventPicker, SecretDialog } from "../webhook-parts"

const DELIVERY_STATUS: Record<WebhookDeliveryStatus, { label: string; variant: "outline" | "destructive" | "secondary" }> = {
  PENDING: { label: "Retrying", variant: "secondary" },
  SUCCEEDED: { label: "Delivered", variant: "outline" },
  DEAD: { label: "Gave up", variant: "destructive" },
}

const replayedSchema = z.object({ replayed: z.int() })

/**
 * One endpoint (ADR-0050): its address and events, on and off, the signing
 * secret's rotation, and the delivery log — every attempt's answer, with a
 * replay for what gave up.
 */
export function WebhookDetail({
  initial,
  firstDeliveries,
}: {
  initial: WebhookEndpoint
  firstDeliveries: Page<WebhookDelivery>
}) {
  const router = useRouter()
  const queries = useQueryClient()
  const [endpoint, setEndpoint] = useState(initial)
  const [url, setUrl] = useState(initial.url)
  const [description, setDescription] = useState(initial.description ?? "")
  const [events, setEvents] = useState<WebhookEventType[]>(initial.eventTypes)
  const [secret, setSecret] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const base = `/org/webhooks/${endpoint.id}`

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      clientApi(base, { method: "PATCH", body, schema: webhookEndpointSchema }),
    onSuccess: (updated) => {
      setEndpoint(updated)
      toast.success("Saved.")
      router.refresh()
    },
    onError: (error) => toast.error(failureMessage(error, "The webhook wasn't saved.")),
  })
  const rotate = useMutation({
    mutationFn: () => clientApi(`${base}/rotate-secret`, { method: "POST", schema: webhookSecretSchema }),
    onSuccess: (rotated) => setSecret(rotated.secret),
    onError: (error) => toast.error(failureMessage(error, "The secret wasn't rotated.")),
  })
  const remove = useMutation({
    mutationFn: () => clientApi(base, { method: "DELETE", schema: null }),
    onSuccess: () => {
      toast.success("Webhook removed.")
      router.push("/settings/webhooks")
      router.refresh()
    },
    onError: (error) => toast.error(failureMessage(error, "The webhook wasn't removed.")),
  })
  const replay = useMutation({
    mutationFn: (deliveryId: string | null) =>
      clientApi(deliveryId === null ? `${base}/deliveries/replay` : `${base}/deliveries/${deliveryId}/replay`, {
        method: "POST",
        schema: replayedSchema,
      }),
    onSuccess: ({ replayed }) => {
      toast.success(replayed === 1 ? "Sent again." : `${String(replayed)} deliveries sent again.`)
      void queries.invalidateQueries({ queryKey: ["webhook-deliveries", endpoint.id] })
    },
    onError: (error) => toast.error(failureMessage(error, "Nothing was replayed.")),
  })

  const dirty =
    url.trim() !== endpoint.url ||
    description.trim() !== (endpoint.description ?? "") ||
    JSON.stringify([...events].sort()) !== JSON.stringify([...endpoint.eventTypes].sort())

  return (
    <>
      <PageHeader
        title="Webhook"
        description={endpoint.description ?? endpoint.url}
      />
      <div className="grid gap-10 px-6 py-6 md:px-10">
        <section className="grid max-w-2xl gap-4">
          <div className="flex items-center gap-3">
            <EndpointStatus endpoint={endpoint} />
            {endpoint.disabledReason !== null && (
              <span className="text-sm text-muted-foreground">{endpoint.disabledReason}</span>
            )}
            {endpoint.status === "ACTIVE" && endpoint.consecutiveFailures > 0 && (
              <span className="text-sm text-muted-foreground">
                {endpoint.consecutiveFailures === 1 ? "1 failure" : `${String(endpoint.consecutiveFailures)} failures in a row`}
                {endpoint.circuitOpenUntil !== null && (
                  <>
                    ; trying again <RelativeTime at={endpoint.circuitOpenUntil} />
                  </>
                )}
              </span>
            )}
          </div>
          <Field>
            <FieldLabel htmlFor="webhook-url">URL</FieldLabel>
            <Input id="webhook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="webhook-description">Description</FieldLabel>
            <Input
              id="webhook-description"
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <EventPicker value={events} onChange={setEvents} />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!dirty || save.isPending || events.length === 0 || url.trim() === ""}
              onClick={() =>
                save.mutate({
                  url: url.trim(),
                  description: description.trim() === "" ? null : description.trim(),
                  eventTypes: events,
                })
              }
            >
              {save.isPending && <Spinner />}
              Save changes
            </Button>
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate({ enabled: endpoint.status !== "ACTIVE" })}
            >
              {endpoint.status === "ACTIVE" ? "Turn off" : "Turn on"}
            </Button>
            <Button variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {rotate.isPending && <Spinner />}
              Rotate secret
            </Button>
            <Button variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Turning it off stops sending: deliveries still waiting to retry give up, and events while it is off
            are not kept for it. Turn it back on, then replay what gave up.
          </p>
          {endpoint.previousSecretExpiresAt !== null && new Date(endpoint.previousSecretExpiresAt) > new Date() && (
            <p className="text-xs text-muted-foreground">
              The previous secret still signs until <RelativeTime at={endpoint.previousSecretExpiresAt} />.
            </p>
          )}
        </section>

        <DeliveryLog
          endpointId={endpoint.id}
          first={firstDeliveries}
          replaying={replay.isPending}
          onReplay={(id) => replay.mutate(id)}
        />
      </div>

      <SecretDialog secret={secret} rotated onClose={() => setSecret(null)} />
      <Dialog open={removing} onOpenChange={(open) => !open && setRemoving(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this webhook?</DialogTitle>
            <DialogDescription>
              Nothing more is sent to it, and its delivery log goes with it. To stop it but keep its log, turn
              it off.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending && <Spinner />}
              Remove webhook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DeliveryLog({
  endpointId,
  first,
  replaying,
  onReplay,
}: {
  endpointId: string
  first: Page<WebhookDelivery>
  replaying: boolean
  onReplay: (deliveryId: string | null) => void
}) {
  const [status, setStatus] = useState<WebhookDeliveryStatus | "">("")
  const log = useInfiniteQuery({
    queryKey: ["webhook-deliveries", endpointId, status],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "25" })
      if (status !== "") query.set("status", status)
      if (pageParam !== null) query.set("cursor", pageParam)
      return clientApi(`/org/webhooks/${endpointId}/deliveries?${query.toString()}`, { schema: webhookDeliveryPageSchema })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    ...(status === "" ? { initialData: { pages: [first], pageParams: [null] } } : {}),
  })
  const rows = log.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Deliveries</h2>
        <NativeSelect
          aria-label="Which deliveries"
          className="w-44"
          value={status}
          onChange={(e) => {
            const parsed = webhookDeliveryStatusSchema.safeParse(e.target.value)
            setStatus(parsed.success ? parsed.data : "")
          }}
        >
          <option value="">All</option>
          <option value="PENDING">Retrying</option>
          <option value="SUCCEEDED">Delivered</option>
          <option value="DEAD">Gave up</option>
        </NativeSelect>
        <Button variant="outline" size="sm" disabled={replaying} onClick={() => onReplay(null)}>
          Replay everything that gave up
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {log.isFetching ? "Loading…" : "Nothing yet. A delivery appears here the moment an event it listens for happens."}
        </p>
      ) : (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Last answer</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <p className="font-mono text-xs">{d.eventType}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{d.id}</p>
                </TableCell>
                <TableCell>
                  <Badge variant={DELIVERY_STATUS[d.status].variant}>{DELIVERY_STATUS[d.status].label}</Badge>
                  {d.status === "PENDING" && d.nextAttemptAt !== null && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      next <RelativeTime at={d.nextAttemptAt} />
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{d.attempts}</TableCell>
                <TableCell className="max-w-xs text-xs">
                  {d.lastStatusCode !== null && <span className="font-mono">{d.lastStatusCode} </span>}
                  {d.lastDurationMs !== null && (
                    <span className="text-muted-foreground">in {d.lastDurationMs} ms </span>
                  )}
                  {d.lastError !== null && <p className="truncate text-muted-foreground" title={d.lastError}>{d.lastError}</p>}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <RelativeTime at={d.createdAt} />
                </TableCell>
                <TableCell>
                  {d.status === "DEAD" && (
                    <Button variant="ghost" size="sm" disabled={replaying} onClick={() => onReplay(d.id)}>
                      Replay
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {log.hasNextPage && (
        <Button variant="outline" className="mt-4" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage && <Spinner />}
          Show older
        </Button>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        <Link href="/settings/webhooks" className="hover:underline">
          ← All webhooks
        </Link>
      </p>
    </section>
  )
}
