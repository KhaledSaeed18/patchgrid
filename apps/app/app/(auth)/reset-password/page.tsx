import type { Metadata } from "next"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"

import { ConfirmResetForm, RequestResetForm } from "./reset-forms"

export const metadata: Metadata = { title: "Reset your password" }

/** Without a token: ask for a link. With one, from the email: choose the new password. */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await searchParams
  const hasToken = typeof token === "string" && token !== ""
  return (
    <AuthShell
      title={hasToken ? "Choose a new password" : "Reset your password"}
      description={
        hasToken
          ? "Changing it signs you out everywhere, so a lost laptop stops working too."
          : "Enter the email on your account and we'll send a link to choose a new password."
      }
      footer={
        <Link
          href="/login"
          className="text-foreground underline underline-offset-4"
        >
          Back to sign in
        </Link>
      }
    >
      {hasToken ? <ConfirmResetForm token={token} /> : <RequestResetForm />}
    </AuthShell>
  )
}
