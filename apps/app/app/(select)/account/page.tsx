import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { serverIdentity } from "@/lib/api/server"

import { EraseAccount } from "./erase-account"
import { SecuritySummary } from "./security/security-summary"

export const metadata: Metadata = { title: "Your account" }

/** The account itself, beyond any one workspace (ADR-0044). */
export default async function AccountPage() {
  const identity = await serverIdentity()
  if (identity === null) redirect("/login?next=%2Faccount")
  return (
    <AuthShell
      title="Your account"
      description={
        <>
          Signed in as{" "}
          <span className="text-foreground">{identity.user.email}</span>.
        </>
      }
      footer={
        <Link
          href="/workspaces"
          className="text-foreground underline underline-offset-4"
        >
          Back to your workspaces
        </Link>
      }
    >
      <SecuritySummary enrolled={identity.mfa.enrolled} />
      <EraseAccount />
    </AuthShell>
  )
}
