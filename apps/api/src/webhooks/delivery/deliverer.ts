import { Injectable, Logger } from "@nestjs/common"

import { AuditService } from "../../audit/audit.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { type AppConfig, InjectConfig } from "../../config/app-config"
import { PrismaService } from "../../prisma/prisma.service"
import { afterFailure, afterSuccess, nextDelayMs, waitForCircuit } from "../domain/schedule"
import { signatureHeaders } from "../domain/signature"
import { WebhookRepository } from "../repositories/webhook.repository"
import { WebhookSecrets } from "../webhook-secrets"
import { BlockedTargetError, describeFailure, postSafely, type SafeResponse } from "../../common/http/safe-request"

/** Long enough for the request's whole timeout and the bookkeeping either side of it. */
const CLAIM_LEASE_MS = 60_000
/** How far a delivery may be early and still count as due: clocks on two hosts differ by a little. */
const CLOCK_TOLERANCE_MS = 2_000
const TIMEOUT_MS = 10_000
const KEEP_RESPONSE_BYTES = 4_096

/** What an attempt came to, and so what the job does next. */
export type AttemptOutcome =
  | { kind: "skipped" }
  | { kind: "delivered" }
  | { kind: "retry"; attempt: number; at: Date }
  | { kind: "postponed"; until: Date }
  | { kind: "dead" }

/**
 * One attempt at one delivery (ADR-0050), inside the tenant. The delivery is
 * claimed first, so a duplicate job does nothing; an open circuit postpones it
 * without spending an attempt. The request goes out between two transactions,
 * never inside one: a slow receiver must not hold a pooled connection. The
 * outcome, the next attempt and the endpoint's circuit are written together,
 * with the endpoint row locked so concurrent outcomes do not lose a count.
 */
@Injectable()
export class WebhookDeliverer {
  private readonly logger = new Logger(WebhookDeliverer.name)

  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly secrets: WebhookSecrets,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async attempt(orgId: string, deliveryId: string): Promise<AttemptOutcome> {
    const now = this.clock.now()
    const claimed = await this.prisma.transaction(async () => {
      const delivery = await this.webhooks.claim(orgId, deliveryId, new Date(now.getTime() + CLOCK_TOLERANCE_MS), new Date(now.getTime() + CLAIM_LEASE_MS))
      if (delivery === null) return null
      return { delivery, endpoint: await this.webhooks.findEndpoint(orgId, delivery.endpointId) }
    })
    if (claimed === null) return { kind: "skipped" }
    const { delivery, endpoint } = claimed

    if (endpoint === null || endpoint.status !== "ACTIVE") {
      await this.prisma.transaction(() => this.webhooks.markDead(orgId, deliveryId, "the endpoint is turned off"))
      return { kind: "dead" }
    }
    const wait = await this.circuitWait(orgId, endpoint, now)
    if (wait !== null) {
      await this.prisma.transaction(() => this.webhooks.postpone(orgId, deliveryId, wait))
      return { kind: "postponed", until: wait }
    }

    let secrets: string[]
    try {
      secrets = this.secrets.inForce(endpoint, now)
    } catch (cause) {
      // Retrying cannot help: the key that sealed it is gone. Said, and stopped, rather than looping forever.
      this.logger.error({ msg: "webhook secret does not open", orgId, endpointId: endpoint.id, error: String(cause) })
      await this.prisma.transaction(() => this.webhooks.markDead(orgId, deliveryId, "the signing secret could not be read; rotate it"))
      return { kind: "dead" }
    }
    const body = JSON.stringify({ id: delivery.id, ...(delivery.payload as Record<string, unknown>) })
    const headers = {
      ...signatureHeaders(secrets, delivery.id, Math.floor(now.getTime() / 1000), body),
      "user-agent": "Patchgrid-Webhooks/1",
    }
    let response: SafeResponse | null = null
    let error: string | null = null
    try {
      response = await postSafely(endpoint.url, body, {
        headers,
        timeoutMs: TIMEOUT_MS,
        maxBodyBytes: KEEP_RESPONSE_BYTES,
        allowPrivate: this.config.WEBHOOK_ALLOW_PRIVATE_TARGETS,
      })
      if (response.status < 200 || response.status >= 300) error = `HTTP ${String(response.status)}: ${response.body.slice(0, 500)}`
    } catch (cause) {
      // The log says what kind of failure; only the server's log says which address (ADR-0050).
      error = describeFailure(cause)
      this.logger.warn({
        msg: "webhook attempt failed",
        orgId,
        endpointId: endpoint.id,
        error: cause instanceof BlockedTargetError ? cause.detail : String(cause),
      })
    }
    return this.record(orgId, delivery.id, delivery.endpointId, delivery.attempts + 1, now, response, error)
  }

  private async record(
    orgId: string,
    deliveryId: string,
    endpointId: string,
    attemptsMade: number,
    attemptedAt: Date,
    response: SafeResponse | null,
    error: string | null,
  ): Promise<AttemptOutcome> {
    const delayMs = error === null ? null : nextDelayMs(attemptsMade, Math.random())
    const recordedAt = this.clock.now()
    const outcome: AttemptOutcome =
      error === null
        ? { kind: "delivered" }
        : delayMs === null
          ? { kind: "dead" }
          : { kind: "retry", attempt: attemptsMade, at: new Date(recordedAt.getTime() + delayMs) }
    await this.prisma.transaction(async () => {
      await this.webhooks.recordAttempt(orgId, deliveryId, {
        status: outcome.kind === "delivered" ? "SUCCEEDED" : outcome.kind === "dead" ? "DEAD" : "PENDING",
        nextAttemptAt: outcome.kind === "retry" ? outcome.at : null,
        attemptedAt,
        statusCode: response?.status ?? null,
        error: error?.slice(0, 1_000) ?? null,
        durationMs: response?.durationMs ?? null,
      })
      const circuit = await this.webhooks.lockCircuit(orgId, endpointId)
      if (circuit === null || circuit.status !== "ACTIVE") return
      if (error === null) {
        if (circuit.consecutiveFailures > 0 || circuit.circuitOpenUntil !== null) await this.webhooks.updateEndpoint(orgId, endpointId, afterSuccess())
        return
      }
      const verdict = afterFailure(circuit, recordedAt)
      const { disable, ...state } = verdict
      if (!disable) {
        await this.webhooks.updateEndpoint(orgId, endpointId, state)
        return
      }
      await this.webhooks.updateEndpoint(orgId, endpointId, { ...state, status: "DISABLED", disabledReason: "Failed for five days without a success" })
      await this.audit.record(orgId, [{ action: "WEBHOOK_DISABLED", entityType: "WebhookEndpoint", entityId: endpointId, diff: { consecutiveFailures: verdict.consecutiveFailures } }], { kind: "system" })
      this.logger.warn({ msg: "webhook endpoint disabled after days of failure", orgId, endpointId })
    })
    return outcome
  }

  /**
   * When an attempt must wait for the endpoint's circuit, or `null` to go now.
   * While it is open, everything waits. Once its time has come, exactly one
   * attempt is the probe: it takes the probe by moving the reopening time a
   * lease ahead, conditionally on the time it saw, so the others find the
   * circuit still open and wait for the probe's answer rather than all going
   * at once (ADR-0050).
   */
  private async circuitWait(orgId: string, endpoint: { id: string; circuitOpenUntil: Date | null }, now: Date): Promise<Date | null> {
    const waiting = waitForCircuit(endpoint, now)
    if (waiting !== null || endpoint.circuitOpenUntil === null) return waiting
    const lease = new Date(now.getTime() + CLAIM_LEASE_MS)
    const probe = await this.prisma.transaction(() => this.webhooks.takeProbe(orgId, endpoint.id, endpoint.circuitOpenUntil ?? now, lease))
    return probe ? null : lease
  }
}
