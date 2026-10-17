import { z } from "zod"

import { idSchema } from "./id.ts"
import { ticketTypeSchema } from "./ticket-number.ts"
import { ticketStatusSchema } from "./tickets.ts"

/**
 * Outbound webhooks (ADR-0050): the public event catalogue, the payload a
 * receiver gets, and the endpoint and delivery shapes the settings pages use.
 *
 * Events are thin: identifiers and states, never titles, descriptions or
 * bodies. A receiver that needs more calls the API with a token, where scopes
 * and role decide what it may read. Internal notes are not in the catalogue.
 */
export const WEBHOOK_EVENT_TYPES = [
  "ticket.created",
  "ticket.assigned",
  "ticket.status_changed",
  "ticket.reopened",
  "comment.created",
  "change.submitted",
  "change.decided",
  "ticket.sla_warning",
  "ticket.sla_breached",
] as const
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES)
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>

/** At most this many endpoints per workspace. */
export const MAX_WEBHOOK_ENDPOINTS = 10

/** The ticket every event is about: what never changes about it, so a stale copy is never wrong. */
const ticketRef = z.object({ id: idSchema, number: z.string(), type: ticketTypeSchema })

/** Who did it: a member, or `null` for the system (a sweep, an automation). */
const actor = idSchema.nullable()

export const webhookEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ticket.created"), ticket: ticketRef, actorMembershipId: actor }),
  z.object({ type: z.literal("ticket.assigned"), ticket: ticketRef, actorMembershipId: actor, assigneeMembershipId: idSchema }),
  z.object({ type: z.literal("ticket.status_changed"), ticket: ticketRef, actorMembershipId: actor, status: ticketStatusSchema }),
  z.object({ type: z.literal("ticket.reopened"), ticket: ticketRef, actorMembershipId: actor }),
  /** Public replies only: an internal note is never a webhook (ADR-0050). */
  z.object({ type: z.literal("comment.created"), ticket: ticketRef, actorMembershipId: actor }),
  z.object({ type: z.literal("change.submitted"), ticket: ticketRef, actorMembershipId: actor }),
  z.object({ type: z.literal("change.decided"), ticket: ticketRef, actorMembershipId: actor, decision: z.enum(["APPROVED", "REJECTED"]) }),
  z.object({ type: z.literal("ticket.sla_warning"), ticket: ticketRef, clock: z.enum(["response", "resolution"]) }),
  z.object({ type: z.literal("ticket.sla_breached"), ticket: ticketRef, clock: z.enum(["response", "resolution"]) }),
])
export type WebhookEventData = z.infer<typeof webhookEventDataSchema>

/**
 * The request body. `id` is the delivery's, the same on every retry and
 * replay, and repeated in the `webhook-id` header: receivers deduplicate on it,
 * because delivery is at least once.
 */
export const webhookPayloadSchema = z.object({
  id: idSchema,
  type: webhookEventTypeSchema,
  /** When the change happened, not when this attempt was made. */
  occurredAt: z.iso.datetime(),
  orgId: idSchema,
  data: webhookEventDataSchema,
})
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>

const eventTypes = z
  .array(webhookEventTypeSchema)
  .min(1)
  .refine((types) => new Set(types).size === types.length, "lists an event type twice")

/**
 * The address. Only its form is checked here; the API refuses private and
 * reserved addresses at save time and again, against every resolved address,
 * at the moment it connects (ADR-0050).
 */
export const webhookUrlSchema = z
  .url({ protocol: /^https?$/, error: "must be an http(s) URL" })
  .max(2_000)
  .refine((url) => {
    const parsed = new URL(url)
    return parsed.username === "" && parsed.password === ""
  }, "must not carry credentials")

export const createWebhookEndpointRequestSchema = z.strictObject({
  url: webhookUrlSchema,
  description: z.string().trim().max(200).optional(),
  eventTypes,
})
export type CreateWebhookEndpointRequest = z.infer<typeof createWebhookEndpointRequestSchema>

export const updateWebhookEndpointRequestSchema = z.strictObject({
  url: webhookUrlSchema.optional(),
  description: z.string().trim().max(200).nullable().optional(),
  eventTypes: eventTypes.optional(),
  /** Turning an endpoint back on closes its circuit and forgets its failures. */
  enabled: z.boolean().optional(),
})
export type UpdateWebhookEndpointRequest = z.infer<typeof updateWebhookEndpointRequestSchema>

export const webhookEndpointStatusSchema = z.enum(["ACTIVE", "DISABLED"])
export type WebhookEndpointStatus = z.infer<typeof webhookEndpointStatusSchema>

export const webhookEndpointSchema = z.object({
  id: idSchema,
  url: z.string(),
  description: z.string().nullable(),
  eventTypes: z.array(webhookEventTypeSchema),
  status: webhookEndpointStatusSchema,
  /** Why it is off: an admin turned it off, or it failed for days. */
  disabledReason: z.string().nullable(),
  /** While open, deliveries wait instead of spending attempts (ADR-0050). */
  circuitOpenUntil: z.iso.datetime().nullable(),
  consecutiveFailures: z.int().nonnegative(),
  /** A rotation's previous secret still signs until then. */
  previousSecretExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>

/** `whsec_` and base64 of 24 bytes: the Standard Webhooks shape. */
export const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{32}$/

/** The answer to creation and rotation: the only time the secret exists outside the API. */
export const webhookSecretSchema = z.object({ secret: z.string().regex(WEBHOOK_SECRET_PATTERN) })
export const createdWebhookEndpointSchema = z.object({ endpoint: webhookEndpointSchema, secret: z.string().regex(WEBHOOK_SECRET_PATTERN) })
export type CreatedWebhookEndpoint = z.infer<typeof createdWebhookEndpointSchema>

export const webhookDeliveryStatusSchema = z.enum(["PENDING", "SUCCEEDED", "DEAD"])
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>

export const webhookDeliverySchema = z.object({
  id: idSchema,
  eventType: webhookEventTypeSchema,
  status: webhookDeliveryStatusSchema,
  attempts: z.int().nonnegative(),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastStatusCode: z.int().nullable(),
  lastError: z.string().nullable(),
  lastDurationMs: z.int().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>

export const webhookDeliveryListQuerySchema = z.object({
  status: webhookDeliveryStatusSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
export type WebhookDeliveryListQuery = z.infer<typeof webhookDeliveryListQuerySchema>
