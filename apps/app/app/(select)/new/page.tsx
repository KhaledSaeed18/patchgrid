import type { Metadata } from "next"
import { cookies } from "next/headers"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"

import {
  CreateWorkspaceForm,
  PENDING_WORKSPACE_COOKIE,
} from "./create-workspace-form"

export const metadata: Metadata = { title: "Create a workspace" }

/** What the visitor chose on the marketing site before confirming their email — a hint, checked like anything typed. */
async function pendingWorkspace(): Promise<{
  name: string
  slug: string
} | null> {
  const raw = (await cookies()).get(PENDING_WORKSPACE_COOKIE)?.value
  if (raw === undefined) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const { name, slug } = value as Record<string, unknown>
    return typeof name === "string" && typeof slug === "string"
      ? { name: name.slice(0, 100), slug: slug.slice(0, 30) }
      : null
  } catch {
    return null
  }
}

export default async function NewWorkspacePage() {
  const pending = await pendingWorkspace()
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
      <CreateWorkspaceForm pending={pending} />
    </AuthShell>
  )
}
