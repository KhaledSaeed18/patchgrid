import {
  categorySchema,
  ticketSchema,
  ticketTypeSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { NewTicketForm, type RaisedFrom } from "./new-ticket-form"

export const metadata: Metadata = { title: "Raise a ticket" }

const ID = z.uuid()

/**
 * Raise a ticket of any type this member may. `?type=` preselects one;
 * `?incident=<id>` raises a Problem from that incident and `?problem=<id>`
 * a Change from that Problem — the source is read here, so a link the
 * member cannot see is never offered.
 */
export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (key: string) => {
    const value = params[key]
    return typeof value === "string" ? value : undefined
  }
  const type = ticketTypeSchema.safeParse(one("type"))
  const [categories, raisedFrom] = await Promise.all([
    serverApi("/categories", { schema: z.array(categorySchema) }),
    source(one("incident"), one("problem")),
  ])
  return (
    <>
      <PageHeader
        title="Raise a ticket"
        description="Tell the support team what's wrong. You'll be able to follow it and reply from My tickets."
      />
      <NewTicketForm
        categories={categories}
        initialType={
          raisedFrom?.kind === "incident"
            ? "PROBLEM"
            : raisedFrom?.kind === "problem"
              ? "CHANGE"
              : type.success
                ? type.data
                : "INCIDENT"
        }
        raisedFrom={raisedFrom}
      />
    </>
  )
}

async function source(
  incident: string | undefined,
  problem: string | undefined
): Promise<RaisedFrom> {
  const id = incident ?? problem
  if (id === undefined || !ID.safeParse(id).success) return null
  const ticket = await serverApi(`/tickets/${id}`, { schema: ticketSchema })
  if (incident !== undefined && ticket.type === "INCIDENT")
    return { kind: "incident", id: ticket.id, number: ticket.number }
  if (problem !== undefined && ticket.type === "PROBLEM")
    return { kind: "problem", id: ticket.id, number: ticket.number }
  return null
}
