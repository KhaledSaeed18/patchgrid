import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { serverIdentity } from "@/lib/api/server"

import { Security } from "./security"

export const metadata: Metadata = { title: "Two-factor authentication" }

/** The second factor, on the account rather than any workspace (ADR-0029, ADR-0045). */
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
      title="Two-factor authentication"
      description={
        <>
          For{" "}
          <span className="text-foreground">{identity.user.email}</span>, in
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
      <Security
        initialEnrolled={identity.mfa.enrolled}
        requiredBy={typeof required === "string" ? required : null}
      />
    </AuthShell>
  )
}
