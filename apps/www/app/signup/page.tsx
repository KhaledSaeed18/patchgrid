import type { Metadata } from "next"

import { SiteHeader } from "@/components/site-header"

import { SignupForm } from "./signup-form"

export const metadata: Metadata = {
  title: "Create a workspace",
  description:
    "Create your Patchgrid account and choose your workspace's address.",
}

export default function SignupPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md px-6 pt-10 pb-24">
        <h1 className="font-serif text-3xl tracking-tight">
          Create a workspace
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Your account first. We&rsquo;ll email a link to confirm your address;
          following it brings you to your new workspace&rsquo;s setup, with the
          name and address you choose here already filled in.
        </p>
        <div className="mt-8">
          <SignupForm />
        </div>
      </main>
    </>
  )
}
