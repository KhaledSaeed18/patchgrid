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
