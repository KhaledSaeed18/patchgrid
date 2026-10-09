import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { serverIdentity } from "@/lib/api/server"

import { SignOutEverywhere, WorkspaceList } from "./workspace-list"

export const metadata: Metadata = { title: "Your workspaces" }

/**
 * The picker (ADR-0024): every workspace this account belongs to, from the
 * projection. Opening one mints that workspace's own cookie pair and leaves
 * the others alone, which is what keeps two workspaces open in two tabs.
 */
export default async function WorkspacesPage() {
  const identity = await serverIdentity()
  if (identity === null) redirect("/login?next=%2Fworkspaces")

  return (
    <AuthShell
      title={
        identity.workspaces.length === 0
          ? "No workspaces yet"
          : "Choose a workspace"
      }
      description={
        <>
          Signed in as{" "}
          <span className="text-foreground">{identity.user.email}</span>.
        </>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/new"
            className="text-foreground underline underline-offset-4"
          >
            Create a workspace
          </Link>
          <SignOutEverywhere />
        </div>
      }
    >
      {identity.workspaces.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Create one for your team, or ask a colleague to invite you to theirs.
          Invitations arrive by email.
        </p>
      ) : (
        <WorkspaceList workspaces={identity.workspaces} />
      )}
    </AuthShell>
  )
}
