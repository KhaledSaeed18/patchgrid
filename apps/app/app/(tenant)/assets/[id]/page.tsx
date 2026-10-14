import { assetDetailSchema, ticketPageSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { serverApi } from "@/lib/api/server"

import { AssetDetailView } from "./asset-detail"

export const metadata: Metadata = { title: "Asset" }

const ID = z.uuid()

/**
 * One asset and its history. The history is the ordinary ticket list
 * narrowed to this asset (`view=all`), so each reader sees exactly the
 * tickets they could open anyway — the asset's owner included.
 */
export default async function AssetPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!ID.safeParse(id).success) notFound()
  const query = new URLSearchParams({
    view: "all",
    assetId: id,
    limit: "25",
  }).toString()
  const [asset, tickets] = await Promise.all([
    serverApi(`/assets/${id}`, { schema: assetDetailSchema }),
    serverApi(`/tickets?${query}`, { schema: ticketPageSchema }),
  ])
  return <AssetDetailView asset={asset} tickets={tickets} query={query} />
}
