"use client"

import { Spinner } from "@patchgrid/ui/components/spinner"
import { useEffect } from "react"

import { currentSlug, refresh, toLogin } from "@/lib/api/client"

/** One refresh, then back where the browser was going — or to sign in if the session is over. */
export function Refresh({ next }: { next: string }) {
  useEffect(() => {
    const slug = currentSlug()
    // Only a path on this host: `next` came from the URL, and must not send the browser elsewhere.
    const back = next.startsWith("/") && !next.startsWith("//") ? next : "/"
    if (slug === null) {
      toLogin()
      return
    }
    void refresh(slug).then((ok) =>
      ok ? window.location.replace(back) : toLogin()
    )
  }, [next])

  return (
    <main className="flex min-h-svh items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Signing you back in…
      </p>
    </main>
  )
}
