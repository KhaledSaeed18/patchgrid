"use client"

import type { IdentityResponse } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { ROOT_DOMAIN, workspaceOrigin } from "@/lib/config"
import { ROLE_LABEL } from "@/lib/labels"

/**
 * The workspace this person's address lets them into (TENANCY.md §5): its
 * owner proved the domain and opened it to the domain's people. Joining makes
 * the membership; opening it is the ordinary picker step after.
 */
export function JoinWorkspace({
  joinable,
}: {
  joinable: NonNullable<IdentityResponse["joinable"]>
}) {
  const join = useMutation({
    mutationFn: async () => {
      await clientApi("/auth/workspaces/join", {
        method: "POST",
        body: { slug: joinable.slug },
        schema: null,
      })
      await clientApi("/auth/sessions", {
        method: "POST",
        body: { slug: joinable.slug },
        schema: null,
      })
    },
    onSuccess: () => window.location.assign(workspaceOrigin(joinable.slug)),
    onError: (error) =>
      toast.error(failureMessage(error, "You couldn't join that workspace.")),
  })
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
      <div className="min-w-0">
        <p className="font-medium">{joinable.name}</p>
        <p className="text-sm text-muted-foreground">
          Your address lets you join{" "}
          <span className="font-mono">
            {joinable.slug}.{ROOT_DOMAIN}
          </span>{" "}
          as {ROLE_LABEL[joinable.role].toLowerCase()}.
        </p>
      </div>
      <Button disabled={join.isPending} onClick={() => join.mutate()}>
        {join.isPending && <Spinner />}
        Join
      </Button>
    </div>
  )
}
