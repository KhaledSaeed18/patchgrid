import { meSchema } from "@patchgrid/contracts"
import { redirect } from "next/navigation"

import { serverApi } from "@/lib/api/server"
import { homeFor } from "@/lib/navigation"

/**
 * A workspace's front door. `proxy.ts` sends `app.`'s `/` to the picker or to
 * login, so only a workspace host reaches here: agents land on their queues,
 * everyone else on their own tickets.
 */
export const dynamic = "force-dynamic"

export default async function Home() {
  const me = await serverApi("/me", { schema: meSchema })
  redirect(homeFor(me.permissions))
}
