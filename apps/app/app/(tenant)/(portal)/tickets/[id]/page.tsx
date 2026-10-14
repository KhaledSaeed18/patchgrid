import {
  categorySchema,
  commentSchema,
  memberPageSchema,
  teamSchema,
  ticketLinkSchema,
  ticketSchema,
  watcherSchema,
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
  const [ticket, comments, watchers, links] = await Promise.all([
    serverApi(`/tickets/${id}`, { schema: ticketSchema }),
    serverApi(`/tickets/${id}/comments`, { schema: z.array(commentSchema) }),
    serverApi(`/tickets/${id}/watchers`, { schema: z.array(watcherSchema) }),
    serverApi(`/tickets/${id}/links`, { schema: z.array(ticketLinkSchema) }),
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
  // Who could be added as a watcher, only for someone who may add them.
  const watchCandidates = ticket.capabilities.canAddWatcher
    ? await serverApi("/members?limit=100", { schema: memberPageSchema }).then(
        (members) => members.items.filter((m) => m.status === "ACTIVE")
      )
    : null
  const categories = ticket.capabilities.editableFields.includes("categoryId")
    ? await serverApi("/categories", { schema: z.array(categorySchema) })
    : []
  return (
    <TicketDetail
      ticket={ticket}
      comments={comments}
      assignable={assignable}
      categories={categories}
      watchers={watchers}
      watchCandidates={watchCandidates}
      links={links}
    />
  )
}
