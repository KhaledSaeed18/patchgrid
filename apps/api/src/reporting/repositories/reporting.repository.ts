import { Injectable } from "@nestjs/common"
import type { Priority, ReportGroup, TicketType } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"
import type { Fact, FactSource } from "../domain/fact"

const SOURCE = {
  id: true,
  version: true,
  type: true,
  priority: true,
  teamId: true,
  categoryId: true,
  assigneeMembershipId: true,
  createdAt: true,
  responseClockStartedAt: true,
  resolutionClockStartedAt: true,
  respondBy: true,
  resolveBy: true,
  respondedAt: true,
  resolvedAt: true,
  closedAt: true,
  cancelledAt: true,
  pausedMinutes: true,
  responseBreached: true,
  resolutionBreached: true,
  reopenCount: true,
  updatedAt: true,
} as const

export type SlaRow = {
  key: string | null
  label: string
  responseMet: number
  responseBreached: number
  responseRunning: number
  resolutionMet: number
  resolutionBreached: number
  resolved: number
  median: number | null
  p90: number | null
}

/**
 * The group a report row is for: the column, and how to name it. Fixed here and
 * chosen by the enum `groupBy` is, so no request ever names a column.
 */
const GROUPS: Record<ReportGroup, { key: string; label: string; join: string }> = {
  priority: { key: `f."priority"::text`, label: `f."priority"::text`, join: "" },
  type: { key: `f."type"::text`, label: `f."type"::text`, join: "" },
  team: {
    key: `f."teamId"::text`,
    label: `COALESCE(t."name", 'No team')`,
    join: `LEFT JOIN "Team" t ON t."orgId" = f."orgId" AND t."id" = f."teamId"`,
  },
  category: {
    key: `f."categoryId"::text`,
    label: `COALESCE(c."name", 'No category')`,
    join: `LEFT JOIN "Category" c ON c."orgId" = f."orgId" AND c."id" = f."categoryId"`,
  },
  assignee: {
    key: `f."assigneeMembershipId"::text`,
    label: `COALESCE(m."displayName", 'Unassigned')`,
    join: `LEFT JOIN "Membership" m ON m."orgId" = f."orgId" AND m."id" = f."assigneeMembershipId"`,
  },
}

/**
 * The reporting read side (ADR-0051). Tenant-owned: every method takes the org
 * and filters on it, and the raw statements run through `prisma.tx`, inside
 * the caller's transaction, where RLS sees the tenant.
 */
@Injectable()
export class ReportingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The tickets a batch of events named, as they are now. */
  sources(orgId: string, ids: readonly string[]): Promise<FactSource[]> {
    if (ids.length === 0) return Promise.resolve([])
    return this.prisma.db.ticket.findMany({ where: { orgId, id: { in: [...ids] } }, select: SOURCE })
  }

  /**
   * Holds the reporting consumer's own lock for this transaction (the key
   * `EventRelay` takes for it), so the reconcile and the consumer never write
   * facts at once: a reconcile batch that read a ticket before a write cannot
   * land its older fact after the consumer's newer one.
   */
  async lockFacts(orgId: string): Promise<void> {
    await this.prisma.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`outbox:${orgId}:reporting`}, 0))`
  }

  /** The reconcile's walk: tickets after `afterId`, in id order. */
  page(orgId: string, afterId: string | null, limit: number): Promise<FactSource[]> {
    return this.prisma.db.ticket.findMany({
      where: { orgId, ...(afterId === null ? {} : { id: { gt: afterId } }) },
      orderBy: { id: "asc" },
      take: limit,
      select: SOURCE,
    })
  }

  async facts(orgId: string, ticketIds: readonly string[]): Promise<Fact[]> {
    if (ticketIds.length === 0) return []
    return this.prisma.db.ticketFact.findMany({
      where: { orgId, ticketId: { in: [...ticketIds] } },
      select: {
        ticketId: true,
        sourceVersion: true,
        type: true,
        priority: true,
        teamId: true,
        categoryId: true,
        assigneeMembershipId: true,
        state: true,
        createdAt: true,
        resolvedAt: true,
        closedAt: true,
        responseMinutes: true,
        resolutionMinutes: true,
        response: true,
        resolution: true,
        reopenCount: true,
      },
    })
  }

  /**
   * Writes facts in one statement. A fact replaces only one built from the
   * same or an older ticket version, so two refreshes racing cannot leave the
   * older state on top (ADR-0051). Returns how many rows it wrote.
   */
  async upsert(orgId: string, facts: readonly Fact[]): Promise<number> {
    if (facts.length === 0) return 0
    const col = <T>(pick: (f: Fact) => T) => facts.map(pick)
    const iso = (d: Date | null) => d?.toISOString() ?? null
    return this.prisma.tx.$executeRaw`
      INSERT INTO "TicketFact" ("orgId", "ticketId", "sourceVersion", "type", "priority", "teamId", "categoryId",
        "assigneeMembershipId", "state", "createdAt", "resolvedAt", "closedAt", "responseMinutes", "resolutionMinutes",
        "response", "resolution", "reopenCount", "refreshedAt")
      SELECT ${orgId}::uuid, u."ticketId", u."sourceVersion", u."type"::"TicketType", u."priority"::"Priority", u."teamId",
        u."categoryId", u."assigneeMembershipId", u."state"::"TicketFactState", u."createdAt", u."resolvedAt", u."closedAt",
        u."responseMinutes", u."resolutionMinutes", u."response"::"ClockOutcome", u."resolution"::"ClockOutcome",
        u."reopenCount", now()
      FROM unnest(
        ${col((f) => f.ticketId)}::uuid[], ${col((f) => f.sourceVersion)}::int[], ${col((f) => f.type)}::text[],
        ${col((f) => f.priority)}::text[], ${col((f) => f.teamId)}::uuid[], ${col((f) => f.categoryId)}::uuid[],
        ${col((f) => f.assigneeMembershipId)}::uuid[], ${col((f) => f.state)}::text[],
        ${col((f) => iso(f.createdAt))}::timestamptz[], ${col((f) => iso(f.resolvedAt))}::timestamptz[],
        ${col((f) => iso(f.closedAt))}::timestamptz[], ${col((f) => f.responseMinutes)}::int[],
        ${col((f) => f.resolutionMinutes)}::int[], ${col((f) => f.response)}::text[], ${col((f) => f.resolution)}::text[],
        ${col((f) => f.reopenCount)}::int[]
      ) AS u("ticketId", "sourceVersion", "type", "priority", "teamId", "categoryId", "assigneeMembershipId", "state",
        "createdAt", "resolvedAt", "closedAt", "responseMinutes", "resolutionMinutes", "response", "resolution", "reopenCount")
      ON CONFLICT ("orgId", "ticketId") DO UPDATE SET
        "sourceVersion" = EXCLUDED."sourceVersion", "type" = EXCLUDED."type", "priority" = EXCLUDED."priority",
        "teamId" = EXCLUDED."teamId", "categoryId" = EXCLUDED."categoryId",
        "assigneeMembershipId" = EXCLUDED."assigneeMembershipId", "state" = EXCLUDED."state",
        "createdAt" = EXCLUDED."createdAt", "resolvedAt" = EXCLUDED."resolvedAt", "closedAt" = EXCLUDED."closedAt",
        "responseMinutes" = EXCLUDED."responseMinutes", "resolutionMinutes" = EXCLUDED."resolutionMinutes",
        "response" = EXCLUDED."response", "resolution" = EXCLUDED."resolution", "reopenCount" = EXCLUDED."reopenCount",
        "refreshedAt" = now()
      WHERE "TicketFact"."sourceVersion" <= EXCLUDED."sourceVersion"`
  }

  /**
   * The SLA report, one row per group: response outcomes of tickets raised in
   * the range, resolution outcomes and times of tickets resolved in it.
   * Cancelled tickets count in neither. One scan per question, by its index.
   */
  sla(orgId: string, from: Date, to: Date, groupBy: ReportGroup): Promise<SlaRow[]> {
    const g = GROUPS[groupBy]
    return this.prisma.tx.$queryRawUnsafe<SlaRow[]>(
      `
      WITH raised AS (
        SELECT ${g.key} AS key, ${g.label} AS label,
          count(*) FILTER (WHERE f."response" = 'MET')::int AS "responseMet",
          count(*) FILTER (WHERE f."response" = 'BREACHED')::int AS "responseBreached",
          count(*) FILTER (WHERE f."response" = 'RUNNING')::int AS "responseRunning"
        FROM "TicketFact" f ${g.join}
        -- A cancelled ticket counts only if its response had already breached: cancelling hides no breach.
        WHERE f."orgId" = $1::uuid AND f."createdAt" >= $2 AND f."createdAt" < $3
          AND (f."state" <> 'CANCELLED' OR f."response" = 'BREACHED')
        GROUP BY 1, 2
      ),
      resolved AS (
        SELECT ${g.key} AS key, ${g.label} AS label,
          count(*) FILTER (WHERE f."resolution" = 'MET')::int AS "resolutionMet",
          count(*) FILTER (WHERE f."resolution" = 'BREACHED')::int AS "resolutionBreached",
          count(*)::int AS resolved,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY f."resolutionMinutes") AS median,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY f."resolutionMinutes") AS p90
        FROM "TicketFact" f ${g.join}
        -- Only tickets with a resolution clock: a Change's or a Problem's lead time is not a time to resolve.
        WHERE f."orgId" = $1::uuid AND f."resolvedAt" >= $2 AND f."resolvedAt" < $3 AND f."state" <> 'CANCELLED'
          AND f."resolution" <> 'NONE'
        GROUP BY 1, 2
      )
      SELECT COALESCE(r.key, s.key) AS key, COALESCE(r.label, s.label) AS label,
        COALESCE(r."responseMet", 0) AS "responseMet", COALESCE(r."responseBreached", 0) AS "responseBreached",
        COALESCE(r."responseRunning", 0) AS "responseRunning", COALESCE(s."resolutionMet", 0) AS "resolutionMet",
        COALESCE(s."resolutionBreached", 0) AS "resolutionBreached", COALESCE(s.resolved, 0) AS resolved,
        s.median, s.p90
      -- A full join needs an equality it can hash; "no team" is the empty key on both sides.
      FROM raised r FULL OUTER JOIN resolved s ON COALESCE(r.key, '') = COALESCE(s.key, '')
      ORDER BY 2`,
      orgId,
      from,
      to,
    )
  }

  /**
   * Percentiles over the whole range. Counts add up across groups and are summed
   * by the caller; a median does not, so the total's is computed, not averaged.
   */
  async resolutionPercentiles(orgId: string, from: Date, to: Date): Promise<{ median: number | null; p90: number | null }> {
    const [row] = await this.prisma.tx.$queryRaw<{ median: number | null; p90: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "resolutionMinutes") AS median,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY "resolutionMinutes") AS p90
        FROM "TicketFact"
       WHERE "orgId" = ${orgId}::uuid AND "resolvedAt" >= ${from} AND "resolvedAt" < ${to} AND "state" <> 'CANCELLED'
         AND "resolution" <> 'NONE'`
    return { median: row?.median ?? null, p90: row?.p90 ?? null }
  }

  /** Open tickets by priority and age bucket (days, at `now`), and by type. */
  async backlog(
    orgId: string,
    now: Date,
  ): Promise<{ byPriority: { priority: Priority; bucket: number; open: number }[]; byType: { type: TicketType; open: number }[] }> {
    const byPriority = await this.prisma.tx.$queryRaw<{ priority: Priority; bucket: number; open: number }[]>`
      SELECT "priority"::text AS priority,
        CASE WHEN age < interval '1 day' THEN 0 WHEN age < interval '3 days' THEN 1 WHEN age < interval '7 days' THEN 2
             WHEN age < interval '30 days' THEN 3 ELSE 4 END AS bucket,
        count(*)::int AS open
      FROM (SELECT "priority", ${now}::timestamptz - "createdAt" AS age FROM "TicketFact"
             WHERE "orgId" = ${orgId}::uuid AND "state" = 'OPEN') o
      GROUP BY 1, 2`
    const byType = await this.prisma.tx.$queryRaw<{ type: TicketType; open: number }[]>`
      SELECT "type"::text AS type, count(*)::int AS open FROM "TicketFact"
       WHERE "orgId" = ${orgId}::uuid AND "state" = 'OPEN' GROUP BY 1 ORDER BY 1`
    return { byPriority, byType }
  }

  /** Who holds the open work, how much of it has breached, and who resolved what in the range. */
  workload(
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<{ membershipId: string | null; label: string; open: number; resolvedInRange: number; breachedOpen: number }[]> {
    return this.prisma.tx.$queryRaw`
      SELECT f."assigneeMembershipId"::text AS "membershipId", COALESCE(m."displayName", 'Unassigned') AS label,
        count(*) FILTER (WHERE f."state" = 'OPEN')::int AS open,
        count(*) FILTER (WHERE f."resolvedAt" >= ${from} AND f."resolvedAt" < ${to} AND f."state" <> 'CANCELLED')::int AS "resolvedInRange",
        count(*) FILTER (WHERE f."state" = 'OPEN' AND (f."response" = 'BREACHED' OR f."resolution" = 'BREACHED'))::int AS "breachedOpen"
      FROM "TicketFact" f
      LEFT JOIN "Membership" m ON m."orgId" = f."orgId" AND m."id" = f."assigneeMembershipId"
      WHERE f."orgId" = ${orgId}::uuid AND (f."state" = 'OPEN' OR (f."resolvedAt" >= ${from} AND f."resolvedAt" < ${to}))
      GROUP BY 1, 2
      ORDER BY open DESC, label`
  }
}
