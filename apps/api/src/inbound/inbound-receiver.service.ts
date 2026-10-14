import { createHash } from "node:crypto"

import { InjectQueue } from "@nestjs/bullmq"
import { Injectable, Logger } from "@nestjs/common"
import { inboundWebhookSchema, MAX_INBOUND_MESSAGE_BYTES } from "@patchgrid/contracts"
import type { Queue } from "bullmq"

import { type Clock, InjectClock } from "../common/clock/clock"
import { NotAuthenticatedProblem, ValidationProblem } from "../common/problems/problem.exception"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { jobId } from "../jobs/job-id"
import { RedisService } from "../redis/redis.service"
import { StorageService } from "../storage/storage.service"
import { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import { slugFromRecipient } from "./domain/recipient"
import { type SignedHeaders, verifySignature } from "./domain/signature"
import type { InboundJob } from "./inbound-intake.service"

export const INBOUND_QUEUE = "inbound-email"
/** Messages one workspace takes in an hour (ADR-0027 §6); past it, mail is dropped before it is stored. */
export const WORKSPACE_HOURLY_LIMIT = 500

/**
 * The webhook's half of intake (ADR-0039), before any tenant: the signature
 * over the raw bytes, then the body, then each envelope recipient resolved to
 * an active workspace the way a request's host would be — exact slug, then a
 * retired one inside its redirect window. The message is stored under that
 * org's prefix and handed to a per-tenant job; nothing is decided about it
 * here. An address that resolves to nothing is logged and otherwise
 * indistinguishable from one that did.
 */
@Injectable()
export class InboundReceiver {
  private readonly logger = new Logger(InboundReceiver.name)

  constructor(
    private readonly lookup: OrganizationLookupService,
    private readonly storage: StorageService,
    @InjectQueue(INBOUND_QUEUE) private readonly queue: Queue,
    private readonly redis: RedisService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async receive(headers: SignedHeaders, body: Buffer): Promise<void> {
    const signature = verifySignature(this.config.INBOUND_WEBHOOK_SECRET, headers, body, this.clock.now())
    if (!signature.ok) {
      this.logger.warn({ msg: "inbound webhook refused", reason: signature.reason })
      throw new NotAuthenticatedProblem("The webhook signature is missing, stale or wrong")
    }

    let json: unknown
    try {
      json = JSON.parse(body.toString("utf8"))
    } catch {
      throw new ValidationProblem([{ path: "body", message: "is not JSON", code: "invalid_webhook" }])
    }
    const parsed = inboundWebhookSchema.safeParse(json)
    if (!parsed.success) throw new ValidationProblem([{ path: "body", message: "is not an email.received event", code: "invalid_webhook" }])
    const raw = Buffer.from(parsed.data.data.raw, "base64")
    if (raw.length === 0 || raw.length > MAX_INBOUND_MESSAGE_BYTES) {
      throw new ValidationProblem([{ path: "data.raw", message: "is empty or larger than the inbound limit", code: "invalid_webhook" }])
    }

    // A provider retry carries the same webhook id: the same key and job id, so it lands once.
    const delivery = createHash("sha256").update(headers.id ?? "").digest("hex").slice(0, 32)
    const receivedAt = this.clock.now().toISOString()
    for (const orgId of await this.tenantsFor(parsed.data.data.recipients)) {
      if (!(await this.withinWorkspaceLimit(orgId))) {
        this.logger.warn({ msg: "inbound message dropped: workspace hourly limit", orgId })
        continue
      }
      const rawStorageKey = `org/${orgId}/inbound/${delivery}.eml`
      await this.storage.put(rawStorageKey, raw, "message/rfc822")
      const job: InboundJob = { orgId, rawStorageKey, receivedAt }
      await this.queue.add("receive", job, { jobId: jobId(INBOUND_QUEUE, orgId, delivery, "receive") })
    }
  }

  /** Each active workspace the envelope names, once. Unresolvable and suspended ones are dropped, never guessed. */
  private async tenantsFor(recipients: readonly string[]): Promise<string[]> {
    const orgIds = new Set<string>()
    for (const recipient of recipients) {
      const slug = slugFromRecipient(recipient, this.config.ROOT_DOMAIN)
      if (slug === null) continue
      const org = (await this.lookup.bySlug(slug)) ?? (await this.retired(slug))
      if (org === null || org.status !== "ACTIVE") {
        this.logger.log({ msg: "inbound recipient dropped", slug, reason: org === null ? "unknown" : org.status })
        continue
      }
      orgIds.add(org.id)
    }
    return [...orgIds]
  }

  /**
   * One count per workspace per clock hour, in Redis, before anything is
   * stored — forged mail with a new sender each time would otherwise grow the
   * log and the bucket without end. Redis unreachable: the message is taken;
   * the signature still had to be right for it to get here.
   */
  private async withinWorkspaceLimit(orgId: string): Promise<boolean> {
    const hour = Math.floor(this.clock.now().getTime() / 3_600_000)
    const key = `inbound:count:${orgId}:${String(hour)}`
    try {
      const results = await this.redis.client.multi().incr(key).expire(key, 7_200).exec()
      const count = results?.[0]?.[1]
      return typeof count !== "number" || count <= WORKSPACE_HOURLY_LIMIT
    } catch (error) {
      this.logger.warn({ msg: "inbound workspace limit unavailable", orgId, error: String(error) })
      return true
    }
  }

  private async retired(slug: string) {
    const retired = await this.lookup.retiredSlug(slug, this.clock.now())
    return retired === null ? null : this.lookup.byId(retired.orgId)
  }
}
