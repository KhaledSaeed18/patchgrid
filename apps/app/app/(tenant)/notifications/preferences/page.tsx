import { notificationPreferencesSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { EmailPreferences } from "./email-preferences"

export const metadata: Metadata = { title: "Notification preferences" }

/**
 * The member's email choices in this workspace (DOMAIN.md §8). They belong
 * to the membership, so the same person chooses again in each workspace.
 */
export default async function NotificationPreferencesPage() {
  const preferences = await serverApi("/notifications/preferences", {
    schema: notificationPreferencesSchema,
  })
  return (
    <>
      <PageHeader
        title="Notification preferences"
        description="Everything arrives in your inbox here. Choose what also reaches your email from this workspace."
      />
      <div className="px-6 py-6 md:px-10">
        <EmailPreferences initial={preferences} />
      </div>
    </>
  )
}
