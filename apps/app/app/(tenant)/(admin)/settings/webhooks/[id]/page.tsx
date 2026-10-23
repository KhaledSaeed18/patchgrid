import {
  idSchema,
  webhookDeliveryPageSchema,
  webhookEndpointSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { serverApi } from "@/lib/api/server"

import { WebhookDetail } from "./webhook-detail"

export const metadata: Metadata = { title: "Webhook" }

export default async function WebhookPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!idSchema.safeParse(id).success) notFound()
  const [endpoint, deliveries] = await Promise.all([
    serverApi(`/org/webhooks/${id}`, { schema: webhookEndpointSchema }),
    serverApi(`/org/webhooks/${id}/deliveries?limit=25`, {
      schema: webhookDeliveryPageSchema,
    }),
  ])
  return <WebhookDetail initial={endpoint} firstDeliveries={deliveries} />
}
