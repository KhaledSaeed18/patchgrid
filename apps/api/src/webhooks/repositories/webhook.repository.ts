import { Injectable } from "@nestjs/common"
import type { TicketType, WebhookDeliveryStatus, WebhookEndpointStatus } from "@patchgrid/contracts"

import { PrismaService } from "../../prisma/prisma.service"

export type EndpointRow = {
  id: string
  url: string
  description: string | null
  eventTypes: string[]
  status: WebhookEndpointStatus
  disabledReason: string | null
  secretSealed: string
  previousSecretSealed: string | null
  previousSecretExpiresAt: Date | null
  consecutiveFailures: number
  circuitOpenUntil: Date | null
  failingSince: Date | null
  createdAt: Date
}

export type DeliveryRow = {
  id: string
  endpointId: string
  eventType: string
  payload: unknown
  status: WebhookDeliveryStatus
  attempts: number
  nextAttemptAt: Date | null
  lastAttemptAt: Date | null
  lastStatusCode: number | null
  lastError: string | null
  lastDurationMs: number | null
  deliveredAt: Date | null
  createdAt: Date
}

export type NewDelivery = { endpointId: string; eventId: string; eventType: string; payload: Record<string, unknown>; nextAttemptAt: Date }

export type EndpointChanges = Partial<
  Pick<
    EndpointRow,
    | "url"
    | "description"
    | "eventTypes"
    | "status"
    | "disabledReason"
    | "secretSealed"
    | "previousSecretSealed"
    | "previousSecretExpiresAt"
    | "consecutiveFailures"
    | "circuitOpenUntil"
    | "failingSince"
  >
>

const ENDPOINT = {
  id: true,
  url: true,
  description: true,
  eventTypes: true,
  status: true,
  disabledReason: true,
  secretSealed: true,
  previousSecretSealed: true,
  previousSecretExpiresAt: true,
  consecutiveFailures: true,
  circuitOpenUntil: true,
  failingSince: true,
  createdAt: true,
} as const

const DELIVERY = {
  id: true,
  endpointId: true,
  eventType: true,
  payload: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  lastAttemptAt: true,
  lastStatusCode: true,
  lastError: true,
  lastDurationMs: true,
  deliveredAt: true,
  createdAt: true,
} as const

/**
 * Webhook endpoints and their deliveries (ADR-0050). Tenant-owned: every method
 * takes the org and filters on it.
 */
@Injectable()
export class WebhookRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Serialises endpoint creation per tenant for this transaction, so the count it checks holds. */
  async lockEndpoints(orgId: string): Promise<void> {
    await this.prisma.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`webhook-endpoints:${orgId}`}, 0))`
  }

  countEndpoints(orgId: string): Promise<number> {
    return this.prisma.db.webhookEndpoint.count({ where: { orgId } })
  }

  async createEndpoint(
    orgId: string,
    data: { url: string; description: string | null; eventTypes: string[]; secretSealed: string; createdByMembershipId: string },
  ): Promise<EndpointRow> {
    return this.prisma.db.webhookEndpoint.create({ data: { orgId, ...data }, select: ENDPOINT })
  }

  listEndpoints(orgId: string): Promise<EndpointRow[]> {
    return this.prisma.db.webhookEndpoint.findMany({ where: { orgId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: ENDPOINT })
  }

  findEndpoint(orgId: string, id: string): Promise<EndpointRow | null> {
    return this.prisma.db.webhookEndpoint.findUnique({ where: { orgId_id: { orgId, id } }, select: ENDPOINT })
  }

  /** The endpoints that should hear of new events: active ones, with what they listen for. */
  activeEndpoints(orgId: string): Promise<{ id: string; eventTypes: string[] }[]> {
    return this.prisma.db.webhookEndpoint.findMany({ where: { orgId, status: "ACTIVE" }, select: { id: true, eventTypes: true } })
  }

  async updateEndpoint(orgId: string, id: string, changes: EndpointChanges): Promise<EndpointRow | null> {
    const { count } = await this.prisma.db.webhookEndpoint.updateMany({ where: { orgId, id }, data: changes })
    return count === 0 ? null : this.findEndpoint(orgId, id)
  }

  /** Its deliveries go with it. Returns whether there was one. */
  async deleteEndpoint(orgId: string, id: string): Promise<boolean> {
    return (await this.prisma.db.webhookEndpoint.deleteMany({ where: { orgId, id } })).count === 1
  }

  /** The facts a public event carries about its tickets, in one read. */
  ticketFacts(orgId: string, ids: readonly string[]): Promise<{ id: string; number: number; type: TicketType }[]> {
    if (ids.length === 0) return Promise.resolve([])
    return this.prisma.db.ticket.findMany({ where: { orgId, id: { in: [...ids] } }, select: { id: true, number: true, type: true } })
  }

  /**
   * One row per endpoint per event; a row that exists already is left alone, so
   * replaying the log writes nothing twice. Returns the rows it wrote.
   */
  async createDeliveries(orgId: string, rows: readonly NewDelivery[]): Promise<{ id: string; nextAttemptAt: Date | null }[]> {
    if (rows.length === 0) return []
    return this.prisma.db.webhookDelivery.createManyAndReturn({
      data: rows.map((r) => ({ orgId, ...r, payload: r.payload as object })),
      skipDuplicates: true,
      select: { id: true, nextAttemptAt: true },
    })
  }

  /**
   * Takes a due delivery for one attempt: it moves `nextAttemptAt` to the end
   * of a lease only if the delivery is still pending and due, so two jobs for
   * one delivery cannot both send it. `null` when someone else has it, or it
   * is not due, or it is finished.
   */
  async claim(orgId: string, id: string, now: Date, leaseUntil: Date): Promise<DeliveryRow | null> {
    const { count } = await this.prisma.db.webhookDelivery.updateMany({
      where: { orgId, id, status: "PENDING", nextAttemptAt: { lte: now } },
      data: { nextAttemptAt: leaseUntil },
    })
    if (count === 0) return null
    return this.prisma.db.webhookDelivery.findUnique({ where: { orgId_id: { orgId, id } }, select: DELIVERY })
  }

  async findDelivery(orgId: string, id: string): Promise<DeliveryRow | null> {
    return this.prisma.db.webhookDelivery.findUnique({ where: { orgId_id: { orgId, id } }, select: DELIVERY })
  }

  /** What one attempt came to. `next` is when to try again, or `null` with `status` DEAD or SUCCEEDED. */
  async recordAttempt(
    orgId: string,
    id: string,
    outcome: {
      status: WebhookDeliveryStatus
      nextAttemptAt: Date | null
      attemptedAt: Date
      statusCode: number | null
      error: string | null
      durationMs: number | null
    },
  ): Promise<void> {
    await this.prisma.db.webhookDelivery.updateMany({
      where: { orgId, id },
      data: {
        status: outcome.status,
        attempts: { increment: 1 },
        nextAttemptAt: outcome.nextAttemptAt,
        lastAttemptAt: outcome.attemptedAt,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.error,
        lastDurationMs: outcome.durationMs,
        ...(outcome.status === "SUCCEEDED" ? { deliveredAt: outcome.attemptedAt } : {}),
      },
    })
  }

  /** The endpoint's circuit, locked for this transaction: two deliveries' outcomes must not lose a count between them. */
  async lockCircuit(
    orgId: string,
    id: string,
  ): Promise<{ status: WebhookEndpointStatus; consecutiveFailures: number; circuitOpenUntil: Date | null; failingSince: Date | null } | null> {
    const rows = await this.prisma.tx.$queryRaw<
      { status: WebhookEndpointStatus; consecutiveFailures: number; circuitOpenUntil: Date | null; failingSince: Date | null }[]
    >`
      SELECT "status"::text AS "status", "consecutiveFailures", "circuitOpenUntil", "failingSince"
        FROM "WebhookEndpoint" WHERE "orgId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`
    return rows[0] ?? null
  }

  /** The tenant's plan, which sets its in-flight cap. */
  async plan(orgId: string): Promise<"FREE" | "PRO"> {
    const org = await this.prisma.db.organization.findUnique({ where: { id: orgId }, select: { plan: true } })
    return org?.plan ?? "FREE"
  }

  /** Waits without spending an attempt: the circuit is open, or the endpoint went away. */
  async postpone(orgId: string, id: string, until: Date): Promise<void> {
    await this.prisma.db.webhookDelivery.updateMany({ where: { orgId, id, status: "PENDING" }, data: { nextAttemptAt: until } })
  }

  async markDead(orgId: string, id: string, reason: string): Promise<void> {
    await this.prisma.db.webhookDelivery.updateMany({ where: { orgId, id, status: "PENDING" }, data: { status: "DEAD", nextAttemptAt: null, lastError: reason } })
  }

  /** An endpoint's log, newest first, keyset-paged on (createdAt, id). */
  listDeliveries(
    orgId: string,
    endpointId: string,
    filter: { status: WebhookDeliveryStatus | undefined; after: { createdAt: Date; id: string } | null; limit: number },
  ): Promise<DeliveryRow[]> {
    return this.prisma.db.webhookDelivery.findMany({
      where: {
        orgId,
        endpointId,
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.after === null
          ? {}
          : { OR: [{ createdAt: { lt: filter.after.createdAt } }, { createdAt: filter.after.createdAt, id: { lt: filter.after.id } }] }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit,
      select: DELIVERY,
    })
  }

  /**
   * Dead deliveries of an endpoint back to pending with their attempts reset:
   * one, when `id` is given, or all of them. Returns the ones it revived.
   */
  async revive(orgId: string, endpointId: string, id: string | null, now: Date): Promise<string[]> {
    const revived = await this.prisma.db.webhookDelivery.findMany({
      where: { orgId, endpointId, status: "DEAD", ...(id === null ? {} : { id }) },
      select: { id: true },
    })
    if (revived.length === 0) return []
    await this.prisma.db.webhookDelivery.updateMany({
      where: { orgId, id: { in: revived.map((r) => r.id) }, status: "DEAD" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lastError: null },
    })
    return revived.map((r) => r.id)
  }

  /** Pending deliveries whose attempt is overdue: the sweep re-queues them in case their job was lost. */
  overdue(orgId: string, before: Date, limit: number): Promise<{ id: string; attempts: number }[]> {
    return this.prisma.db.webhookDelivery.findMany({
      where: { orgId, status: "PENDING", nextAttemptAt: { lte: before } },
      orderBy: { nextAttemptAt: "asc" },
      take: limit,
      select: { id: true, attempts: true },
    })
  }
}
