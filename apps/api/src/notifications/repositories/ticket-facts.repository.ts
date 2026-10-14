import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"
import type { StreamMessage } from "../live/stream-bus"

type TicketUpdated = Extract<StreamMessage, { kind: "ticket-updated" }>

/**
 * What a `ticket-updated` event must carry for every stream to decide, with
 * no I/O of its own, whether its member may read the ticket: the scope
 * columns, the explicit watchers and the workspace's agent visibility. One
 * transaction, two statements, whatever the number of watchers.
 */
@Injectable()
export class TicketFactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async load(orgId: string, ticketId: string): Promise<Omit<TicketUpdated, "kind" | "content"> | null> {
    return this.prisma.transaction(async () => {
      const ticket = await this.prisma.db.ticket.findUnique({
        where: { orgId_id: { orgId, id: ticketId } },
        select: {
          id: true,
          type: true,
          status: true,
          teamId: true,
          requesterMembershipId: true,
          assigneeMembershipId: true,
          updatedAt: true,
          watchers: { select: { membershipId: true } },
        },
      })
      const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { agentVisibility: true } })
      if (ticket === null || org === null) return null
      return {
        ticket: {
          type: ticket.type,
          status: ticket.status,
          teamId: ticket.teamId,
          requesterMembershipId: ticket.requesterMembershipId,
          assigneeMembershipId: ticket.assigneeMembershipId,
          watcherMembershipIds: ticket.watchers.map((w) => w.membershipId),
        },
        visibility: org.agentVisibility,
        event: { ticketId: ticket.id, updatedAt: ticket.updatedAt.toISOString() },
      }
    })
  }
}
