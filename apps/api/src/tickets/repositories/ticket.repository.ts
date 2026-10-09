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
import type { SlaClock, SlaState } from "../domain/sla"

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

/** A search's narrowing; `scope` is the actor's branches, `null` for everything. */
export type SearchFilter = {
  type?: TicketType
  status?: TicketStatus
  scope: readonly ScopeBranch[] | null
}

/** A ticket's clocks as the SLA scan reads them, with its policy's warning thresholds. */
export type RunningClockRow = Pick<
  SlaState,
  | "responseClockStartedAt"
  | "resolutionClockStartedAt"
  | "respondedAt"
  | "resolvedAt"
  | "pausedAt"
  | "respondBy"
  | "resolveBy"
  | "responseBreached"
  | "resolutionBreached"
  | "responseWarningSentAt"
  | "resolutionWarningSentAt"
> & {
  id: string
  slaPolicy: { responseWarningMinutes: number; resolutionWarningMinutes: number } | null
}

export type ListFilter = {
  /** A narrowing of the view, ANDed onto each scope branch. */
  where: { status?: TicketStatus | { in: TicketStatus[] }; assigneeMembershipId?: string | null; requesterMembershipId?: string; teamId?: string | null | { in: string[] } }
  after: { createdAt: Date; id: string } | null
  /** `desc` is newest first. The cursor continues in the same direction. */
  direction: "asc" | "desc"
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
   * Resolved tickets whose resolution is at least as old as `cutoff`, oldest
   * first — the auto-close sweep's work list, a batch at a time.
   */
  async findResolvedBefore(orgId: string, cutoff: Date, limit: number): Promise<{ id: string; version: number }[]> {
    return this.prisma.db.ticket.findMany({
      where: { orgId, status: "RESOLVED", resolvedAt: { lte: cutoff } },
      orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, version: true },
    })
  }

  /**
   * Open incidents and service requests with a clock still able to warn or
   * breach, a page at a time by id — the SLA scan's work list. A breached or
   * stopped clock is not listed; a paused resolution clock only for its
   * response clock.
   */
  async findRunningClocks(orgId: string, after: string | null, limit: number): Promise<RunningClockRow[]> {
    return this.prisma.db.ticket.findMany({
      where: {
        orgId,
        type: { in: ["INCIDENT", "SERVICE_REQUEST"] },
        status: { in: ["NEW", "ASSIGNED", "IN_PROGRESS", "PENDING"] },
        slaPolicyId: { not: null },
        OR: [
          { respondedAt: null, responseBreached: false, respondBy: { not: null } },
          { pausedAt: null, resolutionBreached: false, resolveBy: { not: null } },
        ],
        ...(after === null ? {} : { id: { gt: after } }),
      },
      orderBy: { id: "asc" },
      take: limit,
      select: {
        id: true,
        responseClockStartedAt: true,
        resolutionClockStartedAt: true,
        respondedAt: true,
        resolvedAt: true,
        pausedAt: true,
        respondBy: true,
        resolveBy: true,
        responseBreached: true,
        resolutionBreached: true,
        responseWarningSentAt: true,
        resolutionWarningSentAt: true,
        slaPolicy: { select: { responseWarningMinutes: true, resolutionWarningMinutes: true } },
      },
    })
  }

  /**
   * Sets one SLA flag, only if it is still unset and its clock still running —
   * the condition is in the write, so two scans racing flag once (DOMAIN.md
   * §4.3). Not a versioned write: flags are the system's bookkeeping, and an
   * agent mid-edit should not get a 409 because a warning fired.
   */
  async flagSla(orgId: string, id: string, clock: SlaClock, kind: "warning" | "breach", now: Date): Promise<boolean> {
    const open = { orgId, id, resolvedAt: null }
    const target =
      clock === "response"
        ? kind === "warning"
          ? { where: { ...open, respondedAt: null, responseBreached: false, responseWarningSentAt: null }, data: { responseWarningSentAt: now } }
          : { where: { ...open, respondedAt: null, responseBreached: false }, data: { responseBreached: true } }
        : kind === "warning"
          ? { where: { ...open, pausedAt: null, resolutionBreached: false, resolutionWarningSentAt: null }, data: { resolutionWarningSentAt: now } }
          : { where: { ...open, pausedAt: null, resolutionBreached: false }, data: { resolutionBreached: true } }
    const { count } = await this.prisma.db.ticket.updateMany(target)
    return count === 1
  }

  /**
   * One branch of a scoped list (ADR-0025): an index-friendly query for the
   * branch's column, keyset-paged on (createdAt, id) in either direction. The service runs one per
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
            : filter.direction === "desc"
              ? {
                  OR: [
                    { createdAt: { lt: filter.after.createdAt } },
                    { createdAt: filter.after.createdAt, id: { lt: filter.after.id } },
                  ],
                }
              : {
                  OR: [
                    { createdAt: { gt: filter.after.createdAt } },
                    { createdAt: filter.after.createdAt, id: { gt: filter.after.id } },
                  ],
                },
        ],
      },
      orderBy: [{ createdAt: filter.direction }, { id: filter.direction }],
      take: filter.limit,
      select: SUMMARY,
    })
  }

  /**
   * Direct hits on a ticket number (DOMAIN.md §9.1) — every type when the
   * query named none — within the actor's scope.
   */
  async findByNumber(orgId: string, number: number, filter: SearchFilter): Promise<TicketSummaryRow[]> {
    return this.prisma.db.ticket.findMany({
      where: {
        orgId,
        number,
        AND: [
          filter.type === undefined ? {} : { type: filter.type },
          filter.status === undefined ? {} : { status: filter.status },
          filter.scope === null ? {} : { OR: filter.scope.map(branchWhere) },
        ],
      },
      orderBy: { id: "desc" },
      select: SUMMARY,
    })
  }

  /**
   * Full-text search, ranked (DOMAIN.md §9.1): `websearch_to_tsquery` takes
   * what people type into a search box — quotes, `or`, `-word` — and never
   * fails on it. Raw SQL because Prisma has no tsvector operators; the scope
   * travels as parameters into one static statement, never as SQL text.
   *
   * Ids first, ranked; the summaries then come through the client, so the
   * row shape stays the one the list returns. Run both inside one
   * `transaction()` — one logical read.
   */
  async search(orgId: string, text: string, filter: SearchFilter, limit: number): Promise<TicketSummaryRow[]> {
    const scope = scopeParams(filter.scope)
    const hits = await this.prisma.db.$queryRaw<{ id: string }[]>`
      SELECT t.id
      FROM "Ticket" t, websearch_to_tsquery('english', ${text}) query
      WHERE t."orgId" = ${orgId}::uuid
        AND t."searchVector" @@ query
        AND (${filter.type ?? null}::"TicketType" IS NULL OR t.type = ${filter.type ?? null}::"TicketType")
        AND (${filter.status ?? null}::"TicketStatus" IS NULL OR t.status = ${filter.status ?? null}::"TicketStatus")
        AND (
          ${scope.all}
          OR t."teamId" = ANY(${scope.teamIds}::uuid[])
          OR (${scope.noTeam} AND t."teamId" IS NULL)
          OR t."assigneeMembershipId" = ${scope.assignee}::uuid
          OR t."requesterMembershipId" = ${scope.requester}::uuid
          OR EXISTS (
            SELECT 1 FROM "TicketWatcher" w
            WHERE w."orgId" = t."orgId" AND w."ticketId" = t.id AND w."membershipId" = ${scope.watcher}::uuid
          )
        )
      ORDER BY ts_rank(t."searchVector", query) DESC, t.id DESC
      LIMIT ${limit}
    `
    if (hits.length === 0) return []
    const rows = await this.prisma.db.ticket.findMany({
      where: { orgId, id: { in: hits.map((h) => h.id) } },
      select: SUMMARY,
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    return hits.flatMap((h) => byId.get(h.id) ?? [])
  }
}

/**
 * The scope as the search statement's parameters: each branch switches on
 * one disjunct, and an absent branch leaves its parameter null — which
 * matches nothing. `null` scope is everything.
 */
function scopeParams(scope: readonly ScopeBranch[] | null) {
  const params = {
    all: scope === null,
    teamIds: [] as string[],
    noTeam: false,
    assignee: null as string | null,
    requester: null as string | null,
    watcher: null as string | null,
  }
  for (const branch of scope ?? []) {
    switch (branch.kind) {
      case "teams":
        params.teamIds.push(...branch.teamIds)
        break
      case "no-team":
        params.noTeam = true
        break
      case "assignee":
        params.assignee = branch.membershipId
        break
      case "requester":
        params.requester = branch.membershipId
        break
      case "watcher":
        params.watcher = branch.membershipId
        break
      case "owner":
        throw new Error("an asset scope branch reached the ticket repository")
    }
  }
  return params
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
