import Link from "next/link"

/** One line on the account page: whether the second factor is on, and the way to the page that changes it. */
export function SecuritySummary({ enrolled }: { enrolled: boolean }) {
  return (
    <div className="grid gap-2 border-b border-border pb-6 text-sm leading-relaxed">
      <p className="font-medium">Two-factor authentication</p>
      <p className="text-muted-foreground">
        {enrolled
          ? "On. Signing in takes your password and a code from your authenticator app."
          : "Off. Your password alone signs you in. Some workspaces require a second factor to open."}
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
