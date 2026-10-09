import { Injectable } from "@nestjs/common"
import type {
  Impact,
  Priority,
  TicketSource,
  TicketStatus,
  TicketType,
  Urgency,
} from "@patchgrid/contracts"

import type { ScopeBranch } from "../../authz/scope-filter"
import { PrismaService } from "../../prisma/prisma.service"
import type { SlaState } from "../domain/sla"

export type TicketRow = SlaState & {
  id: string
  orgId: string
  number: number
  type: TicketType
  title: string
  description: string
  status: TicketStatus
  version: number
  impact: Impact
  urgency: Urgency
  priority: Priority
  source: TicketSource
  categoryId: string | null
  requesterMembershipId: string
  assigneeMembershipId: string | null
  teamId: string | null
  slaPolicyId: string | null
  cancelledAt: Date | null
  createdAt: Date
  updatedAt: Date
  category: { id: string; name: string } | null
  requester: { id: string; displayName: string }
  assignee: { id: string; displayName: string } | null
  team: { id: string; name: string } | null
}

/** The fields a write may change; everything else is the row's identity. */
export type TicketChanges = Partial<
  Omit<TicketRow, "id" | "orgId" | "number" | "type" | "version" | "createdAt" | "updatedAt" | "category" | "requester" | "assignee" | "team" | "source">
>

export type TicketSummaryRow = Pick<
  TicketRow,
  | "id"
  | "number"
  | "type"
  | "title"
  | "status"
  | "priority"
  | "respondBy"
  | "resolveBy"
  | "respondedAt"
  | "resolvedAt"
  | "pausedAt"
  | "responseBreached"
  | "resolutionBreached"
  | "createdAt"
  | "updatedAt"
  | "requester"
  | "assignee"
  | "team"
>

export type ListFilter = {
  /** A narrowing of the view, ANDed onto each scope branch. */
  where: { status?: TicketStatus | { in: TicketStatus[] }; assigneeMembershipId?: string | null; requesterMembershipId?: string; teamId?: string | null | { in: string[] } }
  after: { createdAt: Date; id: string } | null
  limit: number
}

const PEOPLE = {
  category: { select: { id: true, name: true } },
  requester: { select: { id: true, displayName: true } },
  assignee: { select: { id: true, displayName: true } },
  team: { select: { id: true, name: true } },
} as const

const SUMMARY = {
  id: true,
  number: true,
  type: true,
  title: true,
  status: true,
  priority: true,
  respondBy: true,
  resolveBy: true,
  respondedAt: true,
  resolvedAt: true,
  pausedAt: true,
  responseBreached: true,
  resolutionBreached: true,
  createdAt: true,
  updatedAt: true,
  requester: PEOPLE.requester,
  assignee: PEOPLE.assignee,
  team: PEOPLE.team,
} as const

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class TicketRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The next number for this type (ADR-0009): one increment under the
   * counter's row lock, which serialises creation per (org, type) until the
   * transaction ends — so it is called LAST in the create transaction.
   */
  async nextNumber(orgId: string, type: TicketType): Promise<number> {
    await this.prisma.db.ticketCounter.createMany({ data: [{ orgId, type }], skipDuplicates: true })
    const counter = await this.prisma.db.ticketCounter.update({
      where: { orgId_type: { orgId, type } },
      data: { nextValue: { increment: 1 } },
      select: { nextValue: true },
    })
    return counter.nextValue - 1
  }

  async create(
    orgId: string,
    data: Omit<TicketRow, "id" | "orgId" | "version" | "createdAt" | "updatedAt" | "category" | "requester" | "assignee" | "team">,
  ): Promise<string> {
    const row = await this.prisma.db.ticket.create({ data: { orgId, ...data }, select: { id: true } })
    return row.id
  }

  findById(orgId: string, id: string): Promise<TicketRow | null> {
    return this.prisma.db.ticket.findUnique({ where: { orgId_id: { orgId, id } }, include: PEOPLE })
  }

  /**
   * Optimistic concurrency (ENGINEERING.md): the write applies only to the
   * version it was made against, and moves it on. `false` means someone else
   * wrote first — 409 `stale-write`.
   */
  async updateVersioned(orgId: string, id: string, version: number, changes: TicketChanges): Promise<boolean> {
    const { count } = await this.prisma.db.ticket.updateMany({
      where: { orgId, id, version },
      data: { ...changes, version: { increment: 1 } },
    })
    return count === 1
  }

  /** A change that is not an edit — a comment's effect on the clocks or status — still moves the version on. */
  async update(orgId: string, id: string, changes: TicketChanges): Promise<void> {
    await this.prisma.db.ticket.update({ where: { orgId_id: { orgId, id } }, data: { ...changes, version: { increment: 1 } } })
  }

  async isWatching(orgId: string, ticketId: string, membershipId: string): Promise<boolean> {
    const row = await this.prisma.db.ticketWatcher.findUnique({
      where: { orgId_ticketId_membershipId: { orgId, ticketId, membershipId } },
      select: { membershipId: true },
    })
    return row !== null
  }

  /**
   * One branch of a scoped list (ADR-0025): an index-friendly query for the
   * branch's column, keyset-paged on (createdAt, id). The service runs one per
   * branch and merges — a UNION ALL done in two passes, without raw SQL.
   */
  async listBranch(orgId: string, branch: ScopeBranch | null, filter: ListFilter): Promise<TicketSummaryRow[]> {
    return this.prisma.db.ticket.findMany({
      // ANDed, never spread together: a view and a branch may both constrain
      // the same column (`teams` and the no-team branch both name teamId),
      // and a spread would let one silently replace the other.
      where: {
        orgId,
        AND: [
          filter.where,
          branchWhere(branch),
          filter.after === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: filter.after.createdAt } },
                  { createdAt: filter.after.createdAt, id: { lt: filter.after.id } },
                ],
              },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: SUMMARY,
    })
  }
}

/** A branch as a `where`. `null` is the unscoped list — an admin's, or an agent under ALL_TICKETS. */
function branchWhere(branch: ScopeBranch | null) {
  if (branch === null) return {}
  switch (branch.kind) {
    case "teams":
      return { teamId: { in: [...branch.teamIds] } }
    case "no-team":
      return { teamId: null }
    case "assignee":
      return { assigneeMembershipId: branch.membershipId }
    case "requester":
      return { requesterMembershipId: branch.membershipId }
    case "watcher":
      return { watchers: { some: { membershipId: branch.membershipId } } }
    case "owner":
      throw new Error("an asset scope branch reached the ticket repository")
  }
}
