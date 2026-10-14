import { Injectable } from "@nestjs/common"
import type { TicketStatus, TicketType } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"
import type { StoredLink } from "../domain/links"

/** A link with the ticket at its other end, as one end reads it. */
export type LinkRow = StoredLink & {
  id: string
  createdAt: Date
  from: LinkedTicket
  to: LinkedTicket
}

/** What the other end shows, and what deciding whether the reader may see it needs. */
export type LinkedTicket = {
  id: string
  number: number
  type: TicketType
  title: string
  status: TicketStatus
  teamId: string | null
  requesterMembershipId: string
  assigneeMembershipId: string | null
}

const END = {
  select: {
    id: true,
    number: true,
    type: true,
    title: true,
    status: true,
    teamId: true,
    requesterMembershipId: true,
    assigneeMembershipId: true,
  },
} as const

/**
 * `TicketLink` (DOMAIN.md §1): one row per fact, in its canonical direction.
 * Tenant-owned; every method takes the org.
 */
@Injectable()
export class LinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every link touching this ticket, from either end, oldest first — one statement. */
  list(orgId: string, ticketId: string): Promise<LinkRow[]> {
    return this.prisma.db.ticketLink.findMany({
      where: { orgId, OR: [{ fromTicketId: ticketId }, { toTicketId: ticketId }] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, fromTicketId: true, toTicketId: true, relation: true, createdAt: true, from: END, to: END },
    })
  }

  find(orgId: string, id: string): Promise<(StoredLink & { id: string }) | null> {
    return this.prisma.db.ticketLink.findUnique({
      where: { orgId_id: { orgId, id } },
      select: { id: true, fromTicketId: true, toTicketId: true, relation: true },
    })
  }

  /** `false` when the same fact is already stated — the unique key decides, not a read first. */
  async create(orgId: string, link: StoredLink, createdByMembershipId: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketLink.createMany({
      data: [{ orgId, ...link, createdByMembershipId }],
      skipDuplicates: true,
    })
    return count === 1
  }

  async createMany(orgId: string, links: readonly StoredLink[], createdByMembershipId: string): Promise<void> {
    if (links.length === 0) return
    await this.prisma.db.ticketLink.createMany({
      data: links.map((link) => ({ orgId, ...link, createdByMembershipId })),
      skipDuplicates: true,
    })
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.ticketLink.deleteMany({ where: { orgId, id } })
    return count === 1
  }

  /**
   * The ticket a duplicate stands for (DOMAIN.md §1): follows `DUPLICATE_OF`
   * to its end, so a new duplicate points at the survivor and chains — and
   * so cycles — cannot form. Bounded: a chain longer than this is a bug.
   */
  async survivorOf(orgId: string, ticketId: string): Promise<string> {
    let current = ticketId
    for (let hop = 0; hop < 20; hop += 1) {
      const next = await this.prisma.db.ticketLink.findFirst({
        where: { orgId, fromTicketId: current, relation: "DUPLICATE_OF" },
        select: { toTicketId: true },
      })
      if (next === null) return current
      current = next.toTicketId
    }
    return current
  }
}
