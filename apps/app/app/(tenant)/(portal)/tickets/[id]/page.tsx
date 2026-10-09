import {
  commentSchema,
  memberPageSchema,
  teamSchema,
  ticketSchema,
} from "@patchgrid/contracts"
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
  // The assignment control's candidates, only for someone who may assign.
  const assignable = ticket.capabilities.canAssign
    ? await Promise.all([
        serverApi("/members?limit=100", { schema: memberPageSchema }),
        serverApi("/teams", { schema: z.array(teamSchema) }),
      ]).then(([members, teams]) => ({
        agents: members.items.filter(
          (m) => m.status === "ACTIVE" && m.role !== "REQUESTER"
        ),
        teams,
      }))
    : null
  return (
    <TicketDetail ticket={ticket} comments={comments} assignable={assignable} />
  )
}
