"use client"

import { platformMeSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"

import { platformApi } from "@/lib/api/platform"

/**
 * The back-office frame (ADR-0040): who is signed in, until when, and the
 * way out. Asking `me` first is also the gate — a browser without a session
 * is sent to the sign-in before any page asks for data.
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const me = useQuery({
    queryKey: ["platform", "me"],
    queryFn: () => platformApi("/auth/me", { schema: platformMeSchema }),
  })
  const signOut = async () => {
    await platformApi("/auth/logout", { method: "POST", schema: null }).catch(
      () => undefined
    )
    window.location.assign("/login")
  }
  return (
    <div className="min-h-svh">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-4 md:px-10">
        <div className="flex items-center gap-6">
          <Link href="/orgs" className="text-sm font-semibold tracking-tight">
            Patchgrid operations
          </Link>
          <nav className="text-sm text-muted-foreground">
            <Link href="/orgs" className="hover:text-foreground">
              Workspaces
            </Link>
          </nav>
        </div>
        {me.data !== undefined && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              {me.data.name} · until{" "}
              {new Date(me.data.sessionExpiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </header>
      {me.data === undefined ? null : children}
    </div>
  )
}
