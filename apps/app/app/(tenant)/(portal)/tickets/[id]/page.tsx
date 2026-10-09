import { commentSchema, ticketSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { serverApi } from "@/lib/api/server"

import { TicketDetail } from "./ticket-detail"

export const metadata: Metadata = { title: "Ticket" }

const ID = z.uuid()

/**
 * One ticket, for whoever may read it. Requesters and agents share the page:
 * what each sees and may do is the server's `availableActions` and
 * `capabilities` (RBAC.md §7), not a second page per role.
 */
export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!ID.safeParse(id).success) notFound()
  const [ticket, comments] = await Promise.all([
    serverApi(`/tickets/${id}`, { schema: ticketSchema }),
    serverApi(`/tickets/${id}/comments`, { schema: z.array(commentSchema) }),
  ])
  return <TicketDetail ticket={ticket} comments={comments} />
}
