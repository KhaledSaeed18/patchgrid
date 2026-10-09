import type { Metadata } from "next"

import { Refresh } from "./refresh"

export const metadata: Metadata = { title: "Signing you back in" }

/**
 * Where a workspace page sends the browser when its access token is missing
 * or about to lapse (ADR-0035): the refresh cookie only ever reaches the API,
 * so only the browser can use it.
 */
export default async function RefreshPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { next } = await searchParams
  return <Refresh next={typeof next === "string" ? next : "/"} />
}
