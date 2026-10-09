import { meSchema } from "@patchgrid/contracts"

import { TenantProvider } from "@/components/tenant-provider"
import { WorkspaceShell } from "@/components/workspace-shell"
import { serverApi } from "@/lib/api/server"

/**
 * Every workspace page. Nothing here may be statically generated: one
 * deployment serves every tenant, so the tenant is a request-time value and
 * never a build-time one (ADR-0016). `GET /me` is read once per navigation and
 * handed down; pages read the role and permissions from it.
 */
export const dynamic = "force-dynamic"

export async function generateMetadata() {
  const me = await serverApi("/me", { schema: meSchema })
  return { title: { default: me.org.name, template: `%s · ${me.org.name}` } }
}

export default async function TenantLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const me = await serverApi("/me", { schema: meSchema })
  return (
    <TenantProvider me={me}>
      <WorkspaceShell>{children}</WorkspaceShell>
    </TenantProvider>
  )
}
