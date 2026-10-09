import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { FormAlert } from "@/components/form-alert"

import { Verify } from "./verify"

export const metadata: Metadata = { title: "Confirm your email" }

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await searchParams
  return (
    <AuthShell title="Confirming your email">
      {typeof token === "string" && token !== "" ? (
        <Verify token={token} />
      ) : (
        <FormAlert>
          This link is missing its code. Open the link from the email again.
        </FormAlert>
      )}
    </AuthShell>
  )
}
