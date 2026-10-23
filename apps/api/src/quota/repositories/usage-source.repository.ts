import { Injectable } from "@nestjs/common"
import type { UsageMetric } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

/**
 * What the counters count, counted again from the rows themselves (TENANCY.md
 * §8), for the nightly reconcile. Tenant-owned: every method takes the org,
 * and runs in the reconcile's transaction after it has locked the counter.
 */
@Injectable()
export class UsageSourceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The counter row, locked: a create racing the recount waits for it rather than being counted twice or lost. */
  async lockCounter(orgId: string, period: string, metric: UsageMetric): Promise<bigint> {
    await this.prisma.db.usageCounter.createMany({ data: [{ orgId, period, metric }], skipDuplicates: true })
    const rows = await this.prisma.tx.$queryRaw<{ value: bigint }[]>`
      SELECT "value" FROM "UsageCounter"
       WHERE "orgId" = ${orgId}::uuid AND "period" = ${period} AND "metric" = ${metric}::"UsageMetric"
       FOR UPDATE`
    return rows[0]?.value ?? 0n
  }

  async setCounter(orgId: string, period: string, metric: UsageMetric, value: bigint): Promise<void> {
    await this.prisma.db.usageCounter.updateMany({ where: { orgId, period, metric }, data: { value } })
  }

  /** A seat: an active human at AGENT or above (ADR-0033). */
  async seats(orgId: string): Promise<bigint> {
    return BigInt(await this.prisma.db.membership.count({ where: { orgId, kind: "HUMAN", status: "ACTIVE", role: { not: "REQUESTER" } } }))
  }

  /** Every article holds a unit from its creation to its deletion, draft or not. */
  async articles(orgId: string): Promise<bigint> {
    return BigInt(await this.prisma.db.knowledgeArticle.count({ where: { orgId } }))
  }

  /** Every attachment row's declared size: a pending upload holds its bytes from the presign on (ADR-0005). */
  async storageBytes(orgId: string): Promise<bigint> {
    const sum = await this.prisma.db.attachment.aggregate({ where: { orgId }, _sum: { sizeBytes: true } })
    return BigInt(sum._sum.sizeBytes ?? 0)
  }

  /** Tokens hold a unit until they are revoked, lapsed or not (TENANCY.md §8). */
  async apiTokens(orgId: string): Promise<bigint> {
    return BigInt(await this.prisma.db.apiToken.count({ where: { orgId, revokedAt: null } }))
  }

  /** Tickets created in `[from, to)`: what the month's cumulative counter should have reached. */
  async ticketsCreated(orgId: string, from: Date, to: Date): Promise<bigint> {
    return BigInt(await this.prisma.db.ticket.count({ where: { orgId, createdAt: { gte: from, lt: to } } }))
  }
}
