"use client"

import {
  MAX_SUPPORT_HOURS,
  type SupportSession,
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
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { useStepUp } from "@/components/mfa/step-up-dialog"
import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { StepUpCancelled } from "@/lib/step-up"

const STATUS_LABEL: Record<SupportSession["status"], string> = {
  REQUESTED: "Waiting for an owner",
  DECLINED: "Declined",
  ACTIVE: "Can read now",
  ENDED: "Ended",
}

const END_LABEL: Record<NonNullable<SupportSession["endReason"]>, string> = {
  EXPIRED: "its time ran out",
  REVOKED: "an owner revoked it",
  AUDIT_FAILED: "a read could not be recorded",
}

const DURATIONS = [1, 4, 8, 24, MAX_SUPPORT_HOURS]

/**
 * The workspace's support sessions (ADR-0020, ADR-0041): what was asked, by
 * whom and why; what was decided; what is running. Owners decide; admins
 * see. The consent screen says in words what a grant allows.
 */
export function SupportAccess({ initial }: { initial: SupportSession[] }) {
  const { holds } = useTenant()
  const router = useRouter()
  const owner = holds("support:grant_access")
  const [granting, setGranting] = useState<SupportSession | null>(null)
  const act = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string
      action: "decline" | "revoke"
    }) =>
      clientApi(`/org/support-sessions/${id}/${action}`, {
        method: "POST",
        schema: supportSessionSchema,
      }),
    onSuccess: (session) => {
      toast.success(
        session.status === "DECLINED" ? "Declined." : "Support access ended."
      )
      router.refresh()
    },
    onError: (error) => toast.error(failureMessage(error, "That didn't work.")),
  })

  if (initial.length === 0) {
    return (
      <p className="px-6 py-6 text-sm text-muted-foreground md:px-10">
        Patchgrid support has never asked for access here.
      </p>
    )
  }
  return (
    <div className="grid gap-4 px-6 py-6 md:px-10">
      {initial.map((session) => (
        <article
          key={session.id}
          className="max-w-3xl rounded-lg border border-border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              {session.operator.name} from Patchgrid support
            </p>
            <Badge
              variant={session.status === "ACTIVE" ? "destructive" : "outline"}
            >
              {STATUS_LABEL[session.status]}
            </Badge>
          </div>
          <p className="mt-2 text-sm">“{session.reason}”</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Asked {new Date(session.requestedAt).toLocaleString()}
            {session.expiresAt !== null && session.status === "ACTIVE" && (
              <>
                {" "}
                · can read until {new Date(session.expiresAt).toLocaleString()}
              </>
            )}
            {session.firstUsedAt !== null && (
              <>
                {" "}
                · first read {new Date(session.firstUsedAt).toLocaleString()}
              </>
            )}
            {session.status === "ENDED" && session.endReason !== null && (
              <> · ended because {END_LABEL[session.endReason]}</>
            )}
          </p>
          {owner && session.status === "REQUESTED" && (
            <div className="mt-3 flex gap-2">
              <Button onClick={() => setGranting(session)}>
                Review and grant
              </Button>
              <Button
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: session.id, action: "decline" })
                }
              >
                Decline
              </Button>
            </div>
          )}
          {owner && session.status === "ACTIVE" && (
            <Button
              variant="destructive"
              className="mt-3"
              disabled={act.isPending}
              onClick={() => act.mutate({ id: session.id, action: "revoke" })}
            >
              {act.isPending && <Spinner />}
              End access now
            </Button>
          )}
        </article>
      ))}
      <GrantDialog session={granting} onClose={() => setGranting(null)} />
    </div>
  )
}

function GrantDialog({
  session,
  onClose,
}: {
  session: SupportSession | null
  onClose: () => void
}) {
  const router = useRouter()
  const [hours, setHours] = useState(4)
  // Letting an outsider read the workspace is a step-up action (ADR-0029).
  const stepUp = useStepUp()
  const grant = useMutation({
    mutationFn: (id: string) =>
      stepUp.guard(() =>
        clientApi(`/org/support-sessions/${id}/grant`, {
          method: "POST",
          body: { hours },
          schema: supportSessionSchema,
        })
      ),
    onSuccess: () => {
      toast.success("Support access granted.")
      onClose()
      router.refresh()
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      toast.error(failureMessage(error, "It wasn't granted."))
    },
  })
  return (
    <>
      {stepUp.dialog}
      <Dialog
        open={session !== null && !stepUp.waiting}
        onOpenChange={(open) => !open && onClose()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Let {session?.operator.name} read this workspace?
            </DialogTitle>
            <DialogDescription>
              Read what this allows before you say yes.
            </DialogDescription>
          </DialogHeader>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            <li>
              They can read everything an admin can read: every ticket,{" "}
              <strong>internal notes included</strong>, files, assets, the
              knowledge base, members and teams, and{" "}
              <strong>this workspace&apos;s audit log</strong>.
            </li>
            <li>
              They cannot change anything: every write is refused. They never
              act as anyone here.
            </li>
            <li>
              Every page they open is written to your audit log, and you get an
              email when they first read.
            </li>
            <li>Any owner can end it at once, here.</li>
          </ul>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">For how long</span>
            <NativeSelect
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              {DURATIONS.map((h) => (
                <option key={h} value={h}>
                  {h === 1
                    ? "1 hour"
                    : h < 24
                      ? `${String(h)} hours`
                      : h === 24
                        ? "1 day"
                        : `${String(h / 24)} days`}
                </option>
              ))}
            </NativeSelect>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Not now
            </Button>
            <Button
              disabled={grant.isPending || session === null}
              onClick={() => session !== null && grant.mutate(session.id)}
            >
              {grant.isPending && <Spinner />}
              Grant read-only access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
