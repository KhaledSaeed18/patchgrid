import { IDENTITY_COOKIE } from "@patchgrid/contracts"
import { cookies } from "next/headers"
import Link from "next/link"
import { Suspense } from "react"

import { appUrl } from "@/lib/config"

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/pricing", label: "Pricing" },
]

const primary =
  "rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/85"

/**
 * The marketing header. Everything but the account links is the same for
 * every visitor, so it is part of the prerendered shell; the account links
 * stream in behind it (ADR-0016).
 */
export function SiteHeader() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5">
      <Link href="/" className="text-sm font-semibold tracking-tight">
        Patchgrid
      </Link>
      <nav aria-label="Main" className="flex items-center gap-5 text-sm">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="hidden text-muted-foreground hover:text-foreground sm:inline"
          >
            {item.label}
          </Link>
        ))}
        <Suspense fallback={<SignedOut />}>
          <AccountLinks />
        </Suspense>
      </nav>
    </header>
  )
}

/**
 * Someone already signed in is offered their workspaces instead of a signup —
 * the one thing this site reads from the session cookie, and only its
 * presence (ADR-0016).
 */
async function AccountLinks() {
  const signedIn = (await cookies()).has(IDENTITY_COOKIE)
  if (!signedIn) return <SignedOut />
  return (
    <a href={appUrl("/workspaces")} className={primary}>
      Your workspaces
    </a>
  )
}

function SignedOut() {
  return (
    <>
      <a
        href={appUrl("/login")}
        className="text-muted-foreground hover:text-foreground"
      >
        Sign in
      </a>
      <Link href="/signup" className={primary}>
        Create a workspace
      </Link>
    </>
  )
}
