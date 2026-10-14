import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { OrgDetail } from "@/components/backoffice/org-detail"
import { PlatformShell } from "@/components/backoffice/platform-shell"

export const metadata: Metadata = { title: "Workspace · Operations" }

export default async function BackofficeOrgPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  return (
    <PlatformShell>
      <OrgDetail id={id} />
    </PlatformShell>
  )
}
