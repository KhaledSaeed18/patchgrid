import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { marketingOrigin } from "@/lib/config"

import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: "Sign in" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { next } = await searchParams
  return (
    <AuthShell
      title="Sign in to Patchgrid"
      description="Use the email you were invited with. You'll pick a workspace next."
      footer={
        <>
          New to Patchgrid?{" "}
          <a
            href={`${marketingOrigin()}/signup`}
            className="text-foreground underline underline-offset-4"
          >
            Create an account
          </a>
        </>
      }
    >
      <LoginForm next={typeof next === "string" ? next : undefined} />
    </AuthShell>
  )
}
