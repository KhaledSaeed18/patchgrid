import { ssoSettingsSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { SsoSettingsForm } from "./sso-settings"

export const metadata: Metadata = { title: "Single sign-on" }

export default async function SsoSettingsPage() {
  const settings = await serverApi("/org/sso", { schema: ssoSettingsSchema })
  return (
    <>
      <PageHeader
        title="Single sign-on"
        description="Send people at your company's email domain to your own identity provider, and add newcomers the first time they sign in. Owners always keep their own Patchgrid sign-in, so a broken provider never locks you out."
      />
      <SsoSettingsForm initial={settings} />
    </>
  )
}
