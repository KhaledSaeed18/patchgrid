import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { PlatformLogin } from "@/components/backoffice/platform-login"

export const metadata: Metadata = { title: "Operations sign-in" }

/** The operators' sign-in (ADR-0040): a password, then a second factor — enrolled first if there is none. */
export default async function BackofficeLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { next } = await searchParams
  return (
    <AuthShell
      title="Patchgrid operations"
      description="For Patchgrid's own operators. Workspace members sign in at their workspace's address."
    >
      <PlatformLogin
        next={
          typeof next === "string" && next.startsWith("/orgs") ? next : "/orgs"
        }
      />
    </AuthShell>
  )
}
