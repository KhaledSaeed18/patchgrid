import type { Permission } from "@patchgrid/contracts"

/**
 * The workspace's navigation, drawn from the role-level permissions `GET /me`
 * returned (RBAC.md §7). Hiding a link is a convenience; the API refuses the
 * page's calls regardless.
 *
 * A page a member reaches by what they may change is, for a read-only support
 * session (ADR-0041), reached by what it may read: `reads` names that.
 */
export type NavItem = {
  label: string
  href: string
  requires: Permission
  reads?: Permission
}
export type NavSection = { label: string | null; items: NavItem[] }

const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { label: "My tickets", href: "/tickets", requires: "ticket:create" },
      {
        label: "Queues",
        href: "/queues",
        requires: "ticket:assign",
        reads: "ticket:read_audit",
      },
      // A requester holds `asset:read` for the assets they own; the page lists exactly those.
      { label: "Assets", href: "/assets", requires: "asset:read" },
      { label: "Knowledge", href: "/knowledge", requires: "kb:read_published" },
      {
        label: "Notifications",
        href: "/notifications",
        requires: "notification:read",
      },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "Workspace", href: "/settings", requires: "org:read_settings" },
      {
        label: "Members",
        href: "/settings/members",
        requires: "member:invite",
        reads: "member:read_contact",
      },
      { label: "Teams", href: "/settings/teams", requires: "team:read" },
      {
        label: "Categories",
        href: "/settings/categories",
        requires: "category:write",
        reads: "category:read",
      },
      {
        label: "SLA targets",
        href: "/settings/sla",
        requires: "sla:write",
        reads: "sla:read",
      },
      {
        label: "Audit log",
        href: "/settings/audit",
        requires: "org:read_audit",
      },
      {
        label: "Inbound email",
        href: "/settings/inbound",
        requires: "org:read_audit",
      },
      {
        label: "API tokens",
        href: "/settings/api-tokens",
        requires: "token:read",
      },
      {
        label: "Webhooks",
        href: "/settings/webhooks",
        requires: "webhook:manage",
      },
      {
        label: "Support access",
        href: "/settings/support",
        requires: "support:read_sessions",
      },
    ],
  },
]

export function navigationFor(
  permissions: readonly Permission[],
  readOnly = false
): NavSection[] {
  const held = new Set(permissions)
  return SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((i) =>
      held.has(readOnly ? (i.reads ?? i.requires) : i.requires)
    ),
  })).filter((section) => section.items.length > 0)
}

/**
 * Where `/` sends a member: agents to the queues they work, everyone else to
 * their own tickets. A support session has raised nothing; it reads queues.
 */
export function homeFor(
  permissions: readonly Permission[],
  readOnly = false
): string {
  return readOnly || permissions.includes("ticket:assign")
    ? "/queues"
    : "/tickets"
}

const TICKET_PAGE = /^\/tickets\/[0-9a-f-]{36}$/

/**
 * The link to mark current for a path. A ticket's own page lives under
 * `/tickets` for everyone, but an agent reaches it from the queues, so for
 * them it belongs there. `/settings` is matched exactly, since every settings
 * page sits beneath it.
 */
export function currentHref(
  pathname: string,
  sections: readonly NavSection[]
): string | null {
  const hrefs = sections.flatMap((s) => s.items.map((i) => i.href))
  if (TICKET_PAGE.test(pathname) && hrefs.includes("/queues")) return "/queues"
  const matches = hrefs.filter(
    (href) =>
      pathname === href ||
      (href !== "/settings" && pathname.startsWith(`${href}/`))
  )
  // The longest match wins: /settings/teams/x is Teams, not Workspace.
  return matches.sort((a, b) => b.length - a.length)[0] ?? null
}
