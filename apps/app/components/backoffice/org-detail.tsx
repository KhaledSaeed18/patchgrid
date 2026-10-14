"use client"

import {
  type Plan,
  planSchema,
  platformOrgDetailSchema,
  type SupportSession,
  supportEntrySchema,
  supportSessionSchema,
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
import { z } from "zod"

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
  const restore = useMutation({
    mutationFn: () =>
      platformApi(`/orgs/${id}/restore`, {
        method: "POST",
        schema: platformOrgDetailSchema,
      }),
    onSuccess: (fresh) => {
      settle(fresh)
      toast.success("The workspace won't be deleted.")
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
          disabled={plan.isPending || o.status === "DELETED"}
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
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              An owner asked for it to be deleted. It is erased for good
              {o.purgeAt === null
                ? " when its window closes"
                : ` on ${new Date(o.purgeAt).toLocaleString()}`}
              ; until then it can be restored as it was.
            </p>
            <Button
              variant="outline"
              className="justify-self-start"
              disabled={restore.isPending}
              onClick={() => restore.mutate()}
            >
              {restore.isPending && <Spinner />}
              Restore workspace
            </Button>
          </div>
        )}
        {o.status === "DELETED" && (
          <p className="text-sm text-muted-foreground">
            Purged. Only this record and its address remain, and the address is
            never given to anyone else.
          </p>
        )}
      </Section>
      {o.status !== "DELETED" && (
        <SupportSection id={id} deleting={o.status === "PENDING_DELETION"} />
      )}
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

const SESSION_LABEL: Record<SupportSession["status"], string> = {
  REQUESTED: "Waiting for an owner",
  DECLINED: "Declined",
  ACTIVE: "Granted",
  ENDED: "Ended",
}

/**
 * Support access (ADR-0041): ask the workspace's owners, with a reason they
 * read; once an owner grants it, open the workspace read-only in a new tab.
 * Every page opened there is in the workspace's own audit log.
 */
function SupportSection({ id, deleting }: { id: string; deleting: boolean }) {
  const queries = useQueryClient()
  const key = ["platform", "org", id, "support"]
  const sessions = useQuery({
    queryKey: key,
    queryFn: () =>
      platformApi(`/orgs/${id}/support`, {
        schema: z.array(supportSessionSchema),
      }),
  })
  const [reason, setReason] = useState("")
  const request = useMutation({
    mutationFn: () =>
      platformApi(`/orgs/${id}/support`, {
        method: "POST",
        body: { reason: reason.trim() },
        schema: supportSessionSchema,
      }),
    onSuccess: () => {
      setReason("")
      void queries.invalidateQueries({ queryKey: key })
      toast.success("Asked. The workspace's owners decide.")
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The request wasn't sent.")),
  })
  const enter = useMutation({
    mutationFn: (sessionId: string) =>
      platformApi(`/orgs/${id}/support/${sessionId}/enter`, {
        method: "POST",
        schema: supportEntrySchema,
      }),
    onSuccess: (entry) => window.open(entry.workspaceUrl, "_blank"),
    onError: (error) =>
      toast.error(failureMessage(error, "The workspace couldn't be opened.")),
  })
  const leave = useMutation({
    mutationFn: () =>
      platformApi(`/orgs/${id}/support/leave`, {
        method: "POST",
        schema: null,
      }),
    onSuccess: () => toast.success("Left the workspace."),
    onError: (error) => toast.error(failureMessage(error, "That didn't work.")),
  })

  const list = sessions.data ?? []
  const open = list.some(
    (s) => s.status === "REQUESTED" || s.status === "ACTIVE"
  )
  return (
    <Section
      title="Support access"
      description="Reading this workspace needs an owner's yes, for a time they choose. It is read-only, and every page you open is written to its audit log."
    >
      <div className="grid gap-4">
        {list.map((s) => (
          <div
            key={s.id}
            className="grid gap-2 border-b border-border pb-3 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{s.operator.name}</span>
              <Badge
                variant={s.status === "ACTIVE" ? "destructive" : "outline"}
              >
                {SESSION_LABEL[s.status]}
              </Badge>
            </div>
            <p className="text-muted-foreground">“{s.reason}”</p>
            {s.status === "ACTIVE" && s.expiresAt !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={enter.isPending}
                  onClick={() => enter.mutate(s.id)}
                >
                  {enter.isPending && <Spinner />}
                  Open read-only
                </Button>
                <Button
                  variant="outline"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate()}
                >
                  Leave
                </Button>
                <span className="text-xs text-muted-foreground">
                  until {new Date(s.expiresAt).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        ))}
        {!open && !deleting && (
          <div className="grid gap-2">
            <Textarea
              aria-label="Why you need access"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ticket #482 shows no SLA timer; I need to see its policy and history."
            />
            <Button
              className="justify-self-start"
              disabled={reason.trim().length < 10 || request.isPending}
              onClick={() => request.mutate()}
            >
              {request.isPending && <Spinner />}
              Ask the owners
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}
