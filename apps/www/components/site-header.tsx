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
    <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-5">
      <Link href="/" className="text-sm font-semibold tracking-tight">
        Patchgrid
      </Link>
      {/* A row of its own on a phone, beside the account links from sm up. */}
      <nav aria-label="Main" className="order-last flex w-full gap-5 text-sm sm:order-none sm:ml-auto sm:w-auto">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center gap-5 text-sm">
        <Suspense fallback={<SignedOut />}>
          <AccountLinks />
        </Suspense>
      </div>
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
