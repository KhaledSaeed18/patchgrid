"use client"

import {
  type Plan,
  planSchema,
  platformOrgDetailSchema,
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
import { Spinner } from "@patchgrid/ui/components/spinner"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { NativeSelect } from "@/components/native-select"
import { PageHeader, Section } from "@/components/page-header"
import { platformApi } from "@/lib/api/platform"
import { failureMessage } from "@/lib/failure"

import { ORG_STATUS_LABEL, PLAN_LABEL } from "./labels"

/**
 * One workspace in the back-office: its metadata and counts, and the changes
 * an operator may make — each written to the workspace's own audit log,
 * which its admins read (RBAC.md §8).
 */
export function OrgDetail({ id }: { id: string }) {
  const queries = useQueryClient()
  const org = useQuery({
    queryKey: ["platform", "org", id],
    queryFn: () =>
      platformApi(`/orgs/${id}`, { schema: platformOrgDetailSchema }),
  })
  const [suspending, setSuspending] = useState(false)
  const settle = (fresh: unknown) => {
    queries.setQueryData(["platform", "org", id], fresh)
    void queries.invalidateQueries({ queryKey: ["platform", "orgs"] })
  }
  const unsuspend = useMutation({
    mutationFn: () =>
      platformApi(`/orgs/${id}/unsuspend`, {
        method: "POST",
        schema: platformOrgDetailSchema,
      }),
    onSuccess: (fresh) => {
      settle(fresh)
      toast.success("The workspace is active again.")
    },
    onError: (error) =>
      toast.error(failureMessage(error, "It wasn't restored.")),
  })
  const plan = useMutation({
    mutationFn: (next: Plan) =>
      platformApi(`/orgs/${id}/plan`, {
        method: "PUT",
        body: { plan: next },
        schema: platformOrgDetailSchema,
      }),
    onSuccess: (fresh) => {
      settle(fresh)
      toast.success(`Now on the ${PLAN_LABEL[fresh.plan]} plan.`)
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The plan wasn't changed.")),
  })

  if (org.data === undefined) return <Spinner className="m-10" />
  const o = org.data
  const counts: [string, string][] = [
    ["Agent seats", String(o.counts.seats)],
    ["Requesters", String(o.counts.requesters)],
    [
      "Tickets",
      `${String(o.counts.tickets)} (${String(o.counts.openTickets)} open)`,
    ],
    ["Assets", String(o.counts.assets)],
    ["Knowledge articles", String(o.counts.articles)],
    [
      "Attachment storage",
      `${(o.counts.storageBytes / 1024 / 1024).toFixed(1)} MB`,
    ],
  ]
  return (
    <>
      <PageHeader
        title={o.name}
        description={
          <>
            <Link href="/orgs" className="hover:underline">
              Workspaces
            </Link>{" "}
            · <span className="font-mono">{o.slug}</span> · created{" "}
            {o.createdAt.slice(0, 10)}
          </>
        }
        action={
          <Badge variant={o.status === "ACTIVE" ? "outline" : "destructive"}>
            {ORG_STATUS_LABEL[o.status]}
          </Badge>
        }
      />
      <Section
        title="Counts"
        description="Read inside the workspace, so its own isolation still applies. No names, no content."
      >
        <dl className="grid gap-3">
          {counts.map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 border-b border-border pb-2 text-sm"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section
        title="Plan"
        description="There is no self-serve billing; an operator sets the plan. Limits change at once and nothing is deleted."
      >
        <NativeSelect
          aria-label="Plan"
          className="w-40"
          value={o.plan}
          disabled={plan.isPending}
          onChange={(e) => {
            const parsed = planSchema.safeParse(e.target.value)
            if (parsed.success) plan.mutate(parsed.data)
          }}
        >
          {planSchema.options.map((p) => (
            <option key={p} value={p}>
              {PLAN_LABEL[p]}
            </option>
          ))}
        </NativeSelect>
      </Section>
      <Section
        title="Service"
        description="Suspending ends every member's sessions at once and refuses the workspace's requests until it is restored. The workspace's admins see who did it, and why, in their audit log."
      >
        {o.status === "ACTIVE" && (
          <Button variant="destructive" onClick={() => setSuspending(true)}>
            Suspend workspace
          </Button>
        )}
        {o.status === "SUSPENDED" && (
          <Button
            variant="outline"
            disabled={unsuspend.isPending}
            onClick={() => unsuspend.mutate()}
          >
            {unsuspend.isPending && <Spinner />}
            Restore workspace
          </Button>
        )}
        {o.status === "PENDING_DELETION" && (
          <p className="text-sm text-muted-foreground">
            Its owner has asked for deletion.
          </p>
        )}
      </Section>
      <SuspendDialog
        id={id}
        open={suspending}
        onOpenChange={setSuspending}
        onDone={settle}
      />
    </>
  )
}

function SuspendDialog({
  id,
  open,
  onOpenChange,
  onDone,
}: {
  id: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (fresh: unknown) => void
}) {
  const [reason, setReason] = useState("")
  const suspend = useMutation({
    mutationFn: () =>
      platformApi(`/orgs/${id}/suspend`, {
        method: "POST",
        body: { reason: reason.trim() },
        schema: platformOrgDetailSchema,
      }),
    onSuccess: (fresh) => {
      onDone(fresh)
      onOpenChange(false)
      setReason("")
      toast.success("The workspace is suspended.")
    },
    onError: (error) =>
      toast.error(failureMessage(error, "It wasn't suspended.")),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend this workspace?</DialogTitle>
          <DialogDescription>
            Everyone in it is signed out now. The reason is written to its audit
            log, which its admins read.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Abuse report #1234: phishing pages sent from this workspace"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it active
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || suspend.isPending}
            onClick={() => suspend.mutate()}
          >
            {suspend.isPending && <Spinner />}
            Suspend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
