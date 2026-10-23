import type { Metadata } from "next"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"
import { FormAlert } from "@/components/form-alert"

import { ConfirmErasure } from "./confirm-erasure"

export const metadata: Metadata = { title: "Erase your account" }

/** The page an erasure link opens (ADR-0044 erratum): what goes, and one button. */
export default async function EraseAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await searchParams
  return (
    <AuthShell
      title="Erase your account"
      description="Your name and address leave every workspace you are in, and you are signed out everywhere. What you wrote — tickets, comments — stays with those workspaces, under “Former member”. This cannot be undone."
      footer={
        <Link href="/login" className="text-foreground underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      {typeof token === "string" && token !== "" ? (
        <ConfirmErasure token={token} />
      ) : (
        <FormAlert>
          This page needs the link from the email. Ask for a new one from your account page.
        </FormAlert>
      )}
    </AuthShell>
  )
}
