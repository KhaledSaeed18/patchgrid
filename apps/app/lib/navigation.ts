import type { Permission } from "@patchgrid/contracts"

/**
 * The workspace's navigation, drawn from the role-level permissions `GET /me`
 * returned (RBAC.md §7). Hiding a link is a convenience; the API refuses the
 * page's calls regardless.
 */
export type NavItem = { label: string; href: string; requires: Permission }
export type NavSection = { label: string | null; items: NavItem[] }

const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { label: "My tickets", href: "/tickets", requires: "ticket:create" },
      { label: "Queues", href: "/queues", requires: "ticket:assign" },
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
      },
      { label: "Teams", href: "/settings/teams", requires: "team:read" },
      {
        label: "Categories",
        href: "/settings/categories",
        requires: "category:write",
      },
      { label: "SLA targets", href: "/settings/sla", requires: "sla:write" },
      {
        label: "Audit log",
        href: "/settings/audit",
        requires: "org:read_audit",
      },
    ],
  },
]

export function navigationFor(
  permissions: readonly Permission[]
): NavSection[] {
  const held = new Set(permissions)
  return SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((i) => held.has(i.requires)),
  })).filter((section) => section.items.length > 0)
}

/** Where `/` sends a member: agents to the queues they work, everyone else to their own tickets. */
export function homeFor(permissions: readonly Permission[]): string {
  return permissions.includes("ticket:assign") ? "/queues" : "/tickets"
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
