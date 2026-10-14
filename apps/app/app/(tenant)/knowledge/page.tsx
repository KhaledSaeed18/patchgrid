import {
  articlePageSchema,
  articleSearchResultSchema,
  articleVisibilitySchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"

import { serverApi } from "@/lib/api/server"

import { KnowledgeIndex } from "./knowledge-index"

export const metadata: Metadata = { title: "Knowledge" }

/**
 * The knowledge base: recently updated articles, or the ranked answers to a
 * search. Which articles a reader sees is the server's decision by
 * visibility; the filters are in the URL.
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (key: string) =>
    typeof params[key] === "string" ? params[key] : undefined
  const q = one("q")?.trim().slice(0, 200) ?? ""
  const visibility = articleVisibilitySchema.safeParse(one("visibility"))

  if (q !== "") {
    const found = await serverApi(
      `/articles/search?q=${encodeURIComponent(q)}&limit=50`,
      { schema: articleSearchResultSchema }
    )
    return <KnowledgeIndex q={q} visibility={undefined} found={found.items} />
  }
  const query = new URLSearchParams({ limit: "25" })
  if (visibility.success) query.set("visibility", visibility.data)
  const first = await serverApi(`/articles?${query.toString()}`, {
    schema: articlePageSchema,
  })
  return (
    <KnowledgeIndex
      q=""
      visibility={visibility.success ? visibility.data : undefined}
      first={first}
      query={query.toString()}
    />
  )
}
