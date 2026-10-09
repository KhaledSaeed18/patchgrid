"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@patchgrid/ui/components/dropdown-menu"
import { cn } from "@patchgrid/ui/lib/utils"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { clientApi } from "@/lib/api/client"
import { appOrigin, ROOT_DOMAIN } from "@/lib/config"
import { ROLE_LABEL } from "@/lib/labels"
import { currentHref, navigationFor } from "@/lib/navigation"

import { useTenant } from "./tenant-provider"

/**
 * The frame of every workspace page: the workspace and its navigation on the
 * left, the member's own menu at its foot. On a narrow screen the navigation
 * sits above the page and scrolls sideways.
 */
export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const me = useTenant()
  const pathname = usePathname()
  const sections = navigationFor(me.permissions)
  const current = currentHref(pathname, sections)
  const active = (href: string) => href === current

  return (
    <div className="min-h-svh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="flex flex-col border-b border-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-svh md:border-r md:border-b-0">
        <div className="px-4 pt-5 pb-3">
          <p className="truncate text-sm font-semibold">{me.org.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {me.org.slug}.{ROOT_DOMAIN}
          </p>
        </div>
        <nav
          aria-label="Workspace"
          className="flex gap-4 overflow-x-auto px-2 pb-3 md:flex-1 md:flex-col md:gap-5 md:overflow-visible"
        >
          {sections.map((section) => (
            <div
              key={section.label ?? "main"}
              className="flex shrink-0 gap-1 md:flex-col"
            >
              {section.label !== null && (
                <p className="hidden px-2 pb-1 text-xs text-muted-foreground md:block">
                  {section.label}
                </p>
              )}
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active(item.href) ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-sm whitespace-nowrap text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    active(item.href) &&
                      "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="hidden border-t border-sidebar-border p-2 md:block">
          <MemberMenu />
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function MemberMenu() {
  const me = useTenant()
  const signOut = async (everywhere: boolean) => {
    await clientApi("/auth/logout", {
      method: "POST",
      body: everywhere ? { everywhere: true } : { slug: me.org.slug },
      schema: null,
      anonymous: true,
    }).catch(() => undefined)
    window.location.assign(
      `${appOrigin()}${everywhere ? "/login" : "/workspaces"}`
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">
            {me.membership.displayName}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {ROLE_LABEL[me.membership.role]}
          </span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {me.user !== null && (
          <DropdownMenuLabel className="truncate">
            {me.user.email}
          </DropdownMenuLabel>
        )}
        <DropdownMenuItem render={<a href={`${appOrigin()}/workspaces`} />}>
          Switch workspace
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut(false)}>
          Sign out of {me.org.name}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut(true)}>
          Sign out everywhere
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
