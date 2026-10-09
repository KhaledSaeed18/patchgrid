import { IDENTITY_COOKIE } from "@patchgrid/contracts"
import { cookies } from "next/headers"
import Link from "next/link"

import { appUrl } from "@/lib/config"

/**
 * The marketing header. Someone already signed in is offered their
 * workspaces instead of a signup — the one thing this site reads from the
 * session cookie, and only its presence (ADR-0016).
 */
export async function SiteHeader() {
  const signedIn = (await cookies()).has(IDENTITY_COOKIE)
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
      <Link href="/" className="text-sm font-semibold tracking-tight">
        Patchgrid
      </Link>
      <nav className="flex items-center gap-5 text-sm">
        <Link
          href="/pricing"
          className="text-muted-foreground hover:text-foreground"
        >
          Pricing
        </Link>
        {signedIn ? (
          <a
            href={appUrl("/workspaces")}
            className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/85"
          >
            Your workspaces
          </a>
        ) : (
          <>
            <a
              href={appUrl("/login")}
              className="text-muted-foreground hover:text-foreground"
            >
              Sign in
            </a>
            <Link
              href="/signup"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/85"
            >
              Create a workspace
            </Link>
          </>
        )}
      </nav>
    </header>
  )
}
