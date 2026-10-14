import {
  assetPageSchema,
  assetStatusSchema,
  assetTypeSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"

import { serverApi } from "@/lib/api/server"

import { AssetRegister } from "./asset-register"

export const metadata: Metadata = { title: "Assets" }

/**
 * The asset register (DOMAIN.md §9.3). An agent sees the organization's; a
 * requester sees the devices they hold — the same page, scoped by the
 * server. The filters live in the URL, so a filtered list is a link.
 */
export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (key: string) =>
    typeof params[key] === "string" ? params[key] : undefined
  const type = assetTypeSchema.safeParse(one("type"))
  const status = assetStatusSchema.safeParse(one("status"))
  const q = one("q")?.trim().slice(0, 100) ?? ""

  const query = new URLSearchParams({ limit: "25" })
  if (q !== "") query.set("q", q)
  if (type.success) query.set("type", type.data)
  if (status.success) query.set("status", status.data)
  const first = await serverApi(`/assets?${query.toString()}`, {
    schema: assetPageSchema,
  })
  return (
    <AssetRegister
      first={first}
      query={query.toString()}
      filters={{
        q,
        type: type.success ? type.data : undefined,
        status: status.success ? status.data : undefined,
      }}
    />
  )
}
