"use client"

import type { Me, Permission } from "@patchgrid/contracts"
import { createContext, useContext } from "react"

/**
 * Who the member is in this workspace, fetched by the server once per
 * navigation (ARCHITECTURE.md §Frontend). Components read the role and the
 * permissions from here and never re-derive them.
 */
const TenantContext = createContext<Me | null>(null)

export function TenantProvider({
  me,
  children,
}: {
  me: Me
  children: React.ReactNode
}) {
  return <TenantContext.Provider value={me}>{children}</TenantContext.Provider>
}

export function useTenant(): Me & {
  holds: (permission: Permission) => boolean
} {
  const me = useContext(TenantContext)
  if (me === null) throw new Error("useTenant() outside a workspace page")
  return { ...me, holds: (permission) => me.permissions.includes(permission) }
}
