import type { Metadata } from "next"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"

import { CreateWorkspaceForm } from "./create-workspace-form"

export const metadata: Metadata = { title: "Create a workspace" }

export default function NewWorkspacePage() {
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
      <CreateWorkspaceForm />
    </AuthShell>
  )
}
