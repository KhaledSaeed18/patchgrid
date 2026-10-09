import { organizationSettingsSchema, usageSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { WorkspaceSettings } from "./workspace-settings"

export const metadata: Metadata = { title: "Workspace settings" }

export default async function SettingsPage() {
  const [settings, usage] = await Promise.all([
    serverApi("/org/settings", { schema: organizationSettingsSchema }),
    serverApi("/org/usage", { schema: usageSchema }),
  ])
  return (
    <>
      <PageHeader
        title="Workspace settings"
        description="How this workspace is named, addressed and run."
      />
      <WorkspaceSettings initial={settings} usage={usage} />
    </>
  )
}
