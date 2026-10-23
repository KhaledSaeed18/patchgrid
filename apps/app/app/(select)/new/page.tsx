import type { Metadata } from "next"
import { cookies } from "next/headers"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"
import { serverIdentity } from "@/lib/api/server"

import {
  PENDING_WORKSPACE_COOKIE,
  parsePendingWorkspace,
} from "@/lib/pending-workspace"

import { JoinWorkspace } from "../workspaces/join-workspace"
import { CreateWorkspaceForm } from "./create-workspace-form"

export const metadata: Metadata = { title: "Create a workspace" }

export default async function NewWorkspacePage() {
  const pending = parsePendingWorkspace(
    (await cookies()).get(PENDING_WORKSPACE_COOKIE)?.value
  )
  // Someone whose address a workspace already opens to (TENANCY.md §5) most likely came to join it.
  const joinable = (await serverIdentity())?.joinable ?? null
  return (
    <AuthShell
      title="Create a workspace"
      description="A workspace is your team's help desk: its own address, members, queues and settings. You'll be its owner."
      footer={
        <Link
          href="/workspaces"
          className="text-foreground underline underline-offset-4"
        >
          Back to your workspaces
        </Link>
      }
    >
      {joinable !== null && (
        <div className="grid gap-2">
          <JoinWorkspace joinable={joinable} />
          <p className="text-sm text-muted-foreground">Or create a new one:</p>
        </div>
      )}
      <CreateWorkspaceForm pending={pending} />
    </AuthShell>
  )
}
