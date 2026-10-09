"use client"

import type { WorkspaceSummary } from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { clientApi } from "@/lib/api/client"
import { appOrigin, ROOT_DOMAIN, workspaceOrigin } from "@/lib/config"
import { ROLE_LABEL } from "@/lib/labels"

export function WorkspaceList({
  workspaces,
}: {
  workspaces: WorkspaceSummary[]
}) {
  const open = useMutation({
    mutationFn: (slug: string) =>
      clientApi("/auth/sessions", {
        method: "POST",
        body: { slug },
        schema: null,
      }).then(() => slug),
    onSuccess: (slug) => window.location.assign(workspaceOrigin(slug)),
    onError: () =>
      toast.error(
        "That workspace couldn't be opened. It may have been suspended, or your access removed."
      ),
  })

  return (
    <ul className="flex flex-col divide-y divide-border border-y border-border">
      {workspaces.map((workspace) => {
        const blocked = unavailable(workspace)
        return (
          <li
            key={workspace.orgId}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{workspace.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {workspace.slug}.{ROOT_DOMAIN}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {blocked === null ? (
                <span className="text-xs text-muted-foreground">
                  {ROLE_LABEL[workspace.role]}
                </span>
              ) : (
                <Badge variant="outline">{blocked}</Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={blocked !== null || open.isPending}
                onClick={() => open.mutate(workspace.slug)}
              >
                {open.isPending && open.variables === workspace.slug && (
                  <Spinner />
                )}
                Open
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Why a listed workspace cannot be entered, or `null` if it can. */
function unavailable(workspace: WorkspaceSummary): string | null {
  if (workspace.orgStatus === "SUSPENDED") return "Suspended"
  if (workspace.status === "DISABLED") return "Access paused"
  return null
}

/** Ends every session of this account, in every workspace (ADR-0024 §5). */
export function SignOutEverywhere() {
  const signOut = useMutation({
    mutationFn: () =>
      clientApi("/auth/logout", {
        method: "POST",
        body: { everywhere: true },
        schema: null,
      }),
    onSettled: () => window.location.assign(`${appOrigin()}/login`),
  })
  return (
    <button
      type="button"
      onClick={() => signOut.mutate()}
      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      Sign out everywhere
    </button>
  )
}
