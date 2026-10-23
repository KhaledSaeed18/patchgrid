import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { SsoSessionNotice } from "@/components/sso-session-notice"
import { serverIdentity } from "@/lib/api/server"

import { Security } from "./security"

export const metadata: Metadata = { title: "Sign-in security" }

/** Second factors — passkeys and an authenticator app — on the account rather than any workspace (ADR-0029, ADR-0045, ADR-0053). */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const identity = await serverIdentity()
  if (identity === null) redirect("/login?next=%2Faccount%2Fsecurity")
  const { required } = await searchParams
  return (
    <AuthShell
      title="Sign-in security"
      description={
        <>
          For <span className="text-foreground">{identity.user.email}</span>, in
          every workspace.
        </>
      }
      footer={
        <Link
          href="/account"
          className="text-foreground underline underline-offset-4"
        >
          Back to your account
        </Link>
      }
    >
      {identity.sso === null ? (
        <Security requiredBy={typeof required === "string" ? required : null} />
      ) : (
        <SsoSessionNotice slug={identity.sso.slug} />
      )}
    </AuthShell>
  )
}
