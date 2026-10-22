import Link from "next/link"

/** One line on the account page: whether a second factor is held, and the way to the page that changes it. */
export function SecuritySummary({ enrolled }: { enrolled: boolean }) {
  return (
    <div className="grid gap-2 border-b border-border pb-6 text-sm leading-relaxed">
      <p className="font-medium">Sign-in security</p>
      <p className="text-muted-foreground">
        {enrolled
          ? "Two-factor authentication is on: a passkey, or your password and a code."
          : "Your password alone signs you in. Add a passkey to sign in without one; some workspaces require a second factor to open."}
      </p>
      <Link
        href="/account/security"
        className="w-fit text-foreground underline underline-offset-4"
      >
        {enrolled ? "Manage" : "Set up"}
      </Link>
    </div>
  )
}
