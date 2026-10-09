import { Injectable } from "@nestjs/common"
import type { Plan, UsageMetric } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type UsageRow = { metric: UsageMetric; period: string; value: bigint }

/**
 * Quota counters (TENANCY.md §8). Every write is ONE statement whose `WHERE`
 * carries the rule, so concurrent requests serialise on the row and the
 * database — not a read in this process — decides who got the last unit.
 */
@Injectable()
export class UsageCounterRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The plan as stored, read in the caller's transaction — not the cached summary. */
  async planOf(orgId: string): Promise<Plan | null> {
    const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { plan: true } })
    return org?.plan ?? null
  }

  async ensure(orgId: string, period: string, metric: UsageMetric): Promise<void> {
    await this.prisma.db.usageCounter.createMany({ data: [{ orgId, period, metric }], skipDuplicates: true })
  }

  /** `true` if the increment fit under `limit` (or there is none) and was applied. */
  async increment(orgId: string, period: string, metric: UsageMetric, amount: number, limit: number | null): Promise<boolean> {
    const { count } = await this.prisma.db.usageCounter.updateMany({
      where: { orgId, period, metric, ...(limit === null ? {} : { value: { lte: BigInt(limit - amount) } }) },
      data: { value: { increment: BigInt(amount) } },
    })
    return count === 1
  }

  /** Never below zero; a decrement that would cross it means the counter had drifted, and floors instead. */
  async decrement(orgId: string, period: string, metric: UsageMetric, amount: number): Promise<"applied" | "floored"> {
    const { count } = await this.prisma.db.usageCounter.updateMany({
      where: { orgId, period, metric, value: { gte: BigInt(amount) } },
      data: { value: { decrement: BigInt(amount) } },
    })
    if (count === 1) return "applied"
    await this.prisma.db.usageCounter.updateMany({ where: { orgId, period, metric }, data: { value: 0n } })
    return "floored"
  }

  async read(orgId: string, period: string, metric: UsageMetric): Promise<bigint> {
    const row = await this.prisma.db.usageCounter.findUnique({
      where: { orgId_period_metric: { orgId, period, metric } },
      select: { value: true },
    })
    return row?.value ?? 0n
  }

  list(orgId: string, periods: string[]): Promise<UsageRow[]> {
    return this.prisma.db.usageCounter.findMany({
      where: { orgId, period: { in: periods } },
      select: { metric: true, period: true, value: true },
    })
  }
}
