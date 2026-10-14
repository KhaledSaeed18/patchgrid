import type { Metadata } from "next"

import { OrgList } from "@/components/backoffice/org-list"
import { PlatformShell } from "@/components/backoffice/platform-shell"

export const metadata: Metadata = { title: "Workspaces · Operations" }

export default function BackofficeOrgsPage() {
  return (
    <PlatformShell>
      <OrgList />
    </PlatformShell>
  )
}
