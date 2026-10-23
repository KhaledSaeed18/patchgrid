import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { SsoSessionNotice } from "@/components/sso-session-notice"
import { serverIdentity } from "@/lib/api/server"

import { ErasureLink } from "@/components/erasure-link"

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
      {identity.sso === null ? (
        <>
          <SecuritySummary enrolled={identity.mfa.enrolled} />
          <EraseAccount email={identity.user.email} />
        </>
      ) : (
        <>
          <SsoSessionNotice slug={identity.sso.slug} />
          <div className="grid gap-2 text-sm">
            <p className="font-medium">Delete your account</p>
            <p className="text-muted-foreground">
              An account your workspace&apos;s single sign-on made has no password; a link to your address proves it is you.
            </p>
            <ErasureLink email={identity.user.email} />
          </div>
        </>
      )}
    </AuthShell>
  )
}
