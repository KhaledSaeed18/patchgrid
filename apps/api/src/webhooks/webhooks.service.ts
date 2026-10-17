import { InjectQueue } from "@nestjs/bullmq"
import { Injectable } from "@nestjs/common"
import {
  type CreatedWebhookEndpoint,
  type CreateWebhookEndpointRequest,
  decodeCursor,
  encodeCursor,
  MAX_WEBHOOK_ENDPOINTS,
  type Page,
  type UpdateWebhookEndpointRequest,
  type WebhookDelivery,
  type WebhookDeliveryListQuery,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@patchgrid/contracts"
import type { Queue } from "bullmq"

import { ActorService } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../common/problems/problem.exception"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { PrismaService } from "../prisma/prisma.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { deliveryJob, WEBHOOK_DELIVER_QUEUE } from "./delivery/deliver-job"
import { BlockedTargetError, checkTarget } from "./delivery/safe-request"
import { newWebhookSecret } from "./domain/signature"
import { type DeliveryRow, type EndpointRow, WebhookRepository } from "./repositories/webhook.repository"
import { WebhookSecrets } from "./webhook-secrets"

/** How long a rotated-out secret keeps signing, so receivers can switch without a gap. */
const ROTATION_OVERLAP_MS = 24 * 3_600_000

/**
 * A workspace's webhooks (ADR-0050): admins and owners add, change, rotate and
 * remove endpoints, read their delivery logs and replay what died. Every change
 * to an endpoint is audited in its transaction; creation and rotation are the
 * only answers that carry a secret.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly secrets: WebhookSecrets,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_DELIVER_QUEUE) private readonly queue: Queue,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(): Promise<WebhookEndpoint[]> {
    const orgId = this.manage()
    return (await this.webhooks.listEndpoints(orgId)).map(toEndpoint)
  }

  async get(id: string): Promise<WebhookEndpoint> {
    const orgId = this.manage()
    return toEndpoint(await this.found(orgId, id))
  }

  async create(request: CreateWebhookEndpointRequest): Promise<CreatedWebhookEndpoint> {
    const orgId = this.manage()
    const actor = this.actors.requireTenantActor()
    const url = this.target(request.url)
    const secret = newWebhookSecret()
    const endpoint = await this.prisma.transaction(async () => {
      // The count and the insert hold together: two admins cannot both add the tenth.
      await this.webhooks.lockEndpoints(orgId)
      if ((await this.webhooks.countEndpoints(orgId)) >= MAX_WEBHOOK_ENDPOINTS) {
        throw new ConflictProblem(`A workspace has at most ${String(MAX_WEBHOOK_ENDPOINTS)} webhooks`)
      }
      const created = await this.webhooks.createEndpoint(orgId, {
        url,
        description: request.description ?? null,
        eventTypes: [...request.eventTypes],
        secretSealed: this.secrets.seal(secret),
        createdByMembershipId: actor.membershipId,
      })
      await this.audit.record(orgId, [
        { action: "WEBHOOK_CREATED", entityType: "WebhookEndpoint", entityId: created.id, diff: { url, eventTypes: request.eventTypes } },
      ])
      return created
    })
    return { endpoint: toEndpoint(endpoint), secret }
  }

  async update(id: string, request: UpdateWebhookEndpointRequest): Promise<WebhookEndpoint> {
    const orgId = this.manage()
    const url = request.url === undefined ? undefined : this.target(request.url)
    return this.prisma.transaction(async () => {
      const before = await this.found(orgId, id)
      const reopened = request.enabled === true && before.status === "DISABLED"
      const updated = await this.webhooks.updateEndpoint(orgId, id, {
        ...(url === undefined ? {} : { url }),
        ...(request.description === undefined ? {} : { description: request.description }),
        ...(request.eventTypes === undefined ? {} : { eventTypes: [...request.eventTypes] }),
        ...(request.enabled === false && before.status === "ACTIVE" ? { status: "DISABLED" as const, disabledReason: "Turned off by an admin" } : {}),
        // Back on: a closed circuit and a clean slate, or the first failure would reopen it at once.
        ...(reopened ? { status: "ACTIVE" as const, disabledReason: null, consecutiveFailures: 0, circuitOpenUntil: null, failingSince: null } : {}),
      })
      if (updated === null) throw new NotFoundProblem()
      await this.audit.record(orgId, [{ action: "WEBHOOK_UPDATED", entityType: "WebhookEndpoint", entityId: id, diff: changed(before, updated) }])
      return toEndpoint(updated)
    })
  }

  async remove(id: string): Promise<void> {
    const orgId = this.manage()
    await this.prisma.transaction(async () => {
      const before = await this.found(orgId, id)
      await this.webhooks.deleteEndpoint(orgId, id)
      await this.audit.record(orgId, [{ action: "WEBHOOK_DELETED", entityType: "WebhookEndpoint", entityId: id, diff: { url: before.url } }])
    })
  }

  /** A new secret now; the old one keeps signing for a day, so receivers switch without a gap. */
  async rotate(id: string): Promise<{ secret: string }> {
    const orgId = this.manage()
    const secret = newWebhookSecret()
    const now = this.clock.now()
    await this.prisma.transaction(async () => {
      const before = await this.found(orgId, id)
      await this.webhooks.updateEndpoint(orgId, id, {
        secretSealed: this.secrets.seal(secret),
        previousSecretSealed: before.secretSealed,
        previousSecretExpiresAt: new Date(now.getTime() + ROTATION_OVERLAP_MS),
      })
      await this.audit.record(orgId, [{ action: "WEBHOOK_SECRET_ROTATED", entityType: "WebhookEndpoint", entityId: id, diff: {} }])
    })
    return { secret }
  }

  async deliveries(id: string, query: WebhookDeliveryListQuery): Promise<Page<WebhookDelivery>> {
    const orgId = this.manage()
    await this.found(orgId, id)
    let after: { createdAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const createdAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || createdAt === null || Number.isNaN(createdAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      after = { createdAt, id: parts.id }
    }
    const rows = await this.webhooks.listDeliveries(orgId, id, { status: query.status, after, limit: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toDelivery),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor({ sortValue: last.createdAt.toISOString(), id: last.id }) : null,
    }
  }

  /** Dead deliveries back into line with their attempts reset: one, or every dead one of the endpoint. */
  async replay(id: string, deliveryId: string | null): Promise<{ replayed: number }> {
    const orgId = this.manage()
    const now = this.clock.now()
    const revived = await this.prisma.transaction(async () => {
      await this.found(orgId, id)
      const ids = await this.webhooks.revive(orgId, id, deliveryId, now)
      if (deliveryId !== null && ids.length === 0) {
        // Not dead (pending or delivered) or not this endpoint's: there is nothing to replay.
        const delivery = await this.webhooks.findDelivery(orgId, deliveryId)
        if (delivery === null || delivery.endpointId !== id) throw new NotFoundProblem()
        throw new ConflictProblem("Only a delivery that has given up can be replayed")
      }
      if (ids.length > 0) {
        await this.audit.record(orgId, [{ action: "WEBHOOK_DELIVERIES_REPLAYED", entityType: "WebhookEndpoint", entityId: id, diff: { count: ids.length } }])
      }
      return ids
    })
    await this.queue.addBulk(revived.map((d) => deliveryJob(orgId, d, `a0-r${String(now.getTime())}`, 0)))
    return { replayed: revived.length }
  }

  private manage(): string {
    this.permissions.assert(this.actors.requireTenantActor(), "webhook:manage")
    return this.tenant.requireOrgId()
  }

  private async found(orgId: string, id: string): Promise<EndpointRow> {
    const endpoint = await this.webhooks.findEndpoint(orgId, id)
    if (endpoint === null) throw new NotFoundProblem()
    return endpoint
  }

  /** The address, refused early when it can never be reached; the attempt checks every resolved address again. */
  private target(url: string): string {
    try {
      return checkTarget(url, this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS).toString()
    } catch (error) {
      if (!(error instanceof BlockedTargetError)) throw error
      throw new ValidationProblem([{ path: "url", message: error.message, code: "blocked_target" }])
    }
  }
}

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    eventTypes: row.eventTypes as WebhookEventType[],
    status: row.status,
    disabledReason: row.disabledReason,
    circuitOpenUntil: row.circuitOpenUntil?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    previousSecretExpiresAt: row.previousSecretExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    eventType: row.eventType as WebhookEventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** What an update changed, for the audit row: never the secret. */
function changed(before: EndpointRow, after: EndpointRow): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  for (const key of ["url", "description", "eventTypes", "status"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) diff[key] = { from: before[key], to: after[key] }
  }
  return diff
}
