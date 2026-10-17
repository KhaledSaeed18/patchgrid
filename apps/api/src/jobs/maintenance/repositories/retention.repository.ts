import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../../prisma/prisma.service"

/**
 * The retention table's per-tenant rows (ADR-0028, ADR-0044), inside
 * `runAsTenant` for the org the sweep names.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** A webhook's finished deliveries, past the log's window; pending ones are still being tried. */
  async deleteFinishedDeliveriesBefore(orgId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.db.webhookDelivery.deleteMany({
      where: { orgId, status: { in: ["SUCCEEDED", "DEAD"] }, createdAt: { lt: before } },
    })
    return count
  }

  /**
   * Outbox events past the window that every consumer has read (ADR-0049), at
   * most `limit` of them: never one ahead of any cursor, so a consumer that is
   * behind loses nothing, and never one a delivery or a dead letter still
   * points at. A consumer with no cursor yet has read nothing, so it holds
   * back everything.
   */
  async deleteConsumedEventsBefore(orgId: string, before: Date, consumers: readonly string[], limit: number): Promise<number> {
    return this.prisma.tx.$executeRaw`
      DELETE FROM "OutboxEvent" WHERE "orgId" = ${orgId}::uuid AND "id" IN (
        SELECT e."id" FROM "OutboxEvent" e
         WHERE e."orgId" = ${orgId}::uuid
           AND e."occurredAt" < ${before}
           AND NOT EXISTS (
             SELECT 1 FROM unnest(${[...consumers]}::text[]) AS n(consumer)
               LEFT JOIN "EventConsumer" c ON c."orgId" = e."orgId" AND c."consumer" = n.consumer
              WHERE (e."txn", e."id") > (COALESCE(c."cursorTxn", 0), COALESCE(c."cursorEventId", '00000000-0000-0000-0000-000000000000'::uuid)))
           AND NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."orgId" = e."orgId" AND d."eventId" = e."id")
           AND NOT EXISTS (SELECT 1 FROM "EventDeadLetter" l WHERE l."orgId" = e."orgId" AND l."eventId" = e."id")
         ORDER BY e."txn", e."id"
         LIMIT ${limit})`
  }

  /** Notifications are delivery state, kept 90 days. */
  async deleteNotificationsBefore(orgId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.db.notification.deleteMany({ where: { orgId, createdAt: { lt: before } } })
    return count
  }
}
