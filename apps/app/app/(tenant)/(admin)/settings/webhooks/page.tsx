import { webhookEndpointSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { WebhookList } from "./webhook-list"

export const metadata: Metadata = { title: "Webhooks" }

export default async function WebhooksPage() {
  const endpoints = await serverApi("/org/webhooks", {
    schema: z.array(webhookEndpointSchema),
  })
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Tell another system when something happens here. Each request is signed, carries ids and states but never a ticket's words, and is retried until it is answered. Receivers fetch what else they need with an API token."
      />
      <WebhookList initial={endpoints} />
    </>
  )
}
