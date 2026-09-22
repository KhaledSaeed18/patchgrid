import Link from "next/link"

/**
 * M0 index.
 *
 * In M1 this stops existing as a page: `proxy.ts` parses the host and sends
 * `app.<root>` to the workspace picker and `<slug>.<root>` to the tenant
 * workspace, redirecting to login when there is no session. Until then it is the
 * quickest way to see that the route groups resolve.
 */
const SURFACES = [
  { group: "(auth)", href: "/login", label: "Login", milestone: "M1" },
  {
    group: "(auth)",
    href: "/accept-invite",
    label: "Accept invite",
    milestone: "M1",
  },
  {
    group: "(auth)",
    href: "/reset-password",
    label: "Reset password",
    milestone: "M1",
  },
  {
    group: "(select)",
    href: "/workspaces",
    label: "Workspace picker",
    milestone: "M1",
  },
  {
    group: "(select)",
    href: "/new",
    label: "Create workspace",
    milestone: "M1",
  },
  { group: "(portal)", href: "/tickets", label: "My tickets", milestone: "M2" },
  { group: "(console)", href: "/queues", label: "Queues", milestone: "M2" },
  {
    group: "(admin)",
    href: "/settings",
    label: "Workspace settings",
    milestone: "M1",
  },
]

export default function Page() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-24">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium tracking-tight">
          Patchgrid workspace
        </h1>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
          Route groups are in place; the screens arrive with the milestones that
          give them something to show. Host parsing — apex to the picker, a slug
          to that tenant&apos;s workspace — lands in M1.
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {SURFACES.map((surface) => (
          <li key={surface.href}>
            <Link
              href={surface.href}
              className="-mx-3 flex items-baseline gap-3 rounded-md px-3 py-2 hover:bg-muted/50"
            >
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {surface.group}
              </span>
              <span className="flex-1 text-sm">{surface.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {surface.milestone}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
