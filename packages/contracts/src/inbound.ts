import { z } from "zod"

import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"

/**
 * Email intake (ADR-0027, ADR-0039). Mail to `<slug>@inbound.<root domain>`
 * becomes a ticket, or a reply on one, only when the sender is authenticated
 * by DMARC and is an active member; everything else is recorded and dropped.
 */

/** The label under the root domain that carries every tenant's inbound mail. Reserved as a slug. */
export const INBOUND_SUBDOMAIN = "inbound"

/** `acme@inbound.patchgrid.xyz` — what a tenant's mail is addressed to, and the `Reply-To` of its notifications. */
export function inboundAddress(slug: string, rootDomain: string): string {
  return `${slug}@${INBOUND_SUBDOMAIN}.${rootDomain}`
}

/** The largest raw message the webhook takes, before base64. */
export const MAX_INBOUND_MESSAGE_BYTES = 25 * 1024 * 1024

/**
 * The webhook body (ADR-0039): the envelope recipients routing used, and the
 * message exactly as received. Signed with the Standard Webhooks scheme; the
 * signature is checked over the bytes before this is parsed.
 */
export const inboundWebhookSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    recipients: z.array(z.string().trim().toLowerCase().max(320)).min(1).max(50),
    raw: z
      .string()
      .max(Math.ceil((MAX_INBOUND_MESSAGE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, { error: "must be base64" }),
  }),
})
export type InboundWebhook = z.infer<typeof inboundWebhookSchema>

/** Storage twin: Prisma's `AuthVerdict`. DMARC-aligned pass, any other result, or no trusted result. */
export const authVerdictSchema = z.enum(["PASS", "FAIL", "NONE"])
export type AuthVerdict = z.infer<typeof authVerdictSchema>

/** Storage twin: Prisma's `InboundOutcome`. What became of a message, and why. */
export const inboundOutcomeSchema = z.enum([
  /** Waiting for its job. */
  "RECEIVED",
  /** A new ticket. */
  "CREATED",
  /** A reply on a ticket the sender takes part in. */
  "THREADED",
  /** DMARC did not pass: no ticket, and no reply to a sender who may be forged. */
  "UNAUTHENTICATED",
  /** Authenticated, but not an active member of this workspace. */
  "UNKNOWN_SENDER",
  /** A bounce, an out-of-office or list mail — never a ticket, never answered. */
  "AUTO_REPLY",
  /** Too much mail from one sender in an hour. */
  "RATE_LIMITED",
  /** Unreadable, or failed while being processed. */
  "FAILED",
])
export type InboundOutcome = z.infer<typeof inboundOutcomeSchema>

/** One row of the inbound log admins read (ADR-0027): what arrived, whether it was trusted, what it became. */
export const inboundEmailSchema = z.object({
  id: idSchema,
  fromAddress: z.string(),
  subject: z.string(),
  authVerdict: authVerdictSchema,
  outcome: inboundOutcomeSchema,
  sender: z.object({ membershipId: idSchema, displayName: z.string() }).nullable(),
  ticket: z.object({ id: idSchema, number: z.string() }).nullable(),
  /** Files left out — not an allowed type, too large, or past the storage quota. */
  skippedAttachments: z.array(z.object({ filename: z.string(), reason: z.string() })),
  receivedAt: z.iso.datetime(),
})
export type InboundEmail = z.infer<typeof inboundEmailSchema>

export const inboundEmailPageSchema = pageSchema(inboundEmailSchema)
export type InboundEmailPage = z.infer<typeof inboundEmailPageSchema>

export const inboundEmailListQuerySchema = paginationQuerySchema.extend({
  outcome: inboundOutcomeSchema.optional(),
})
export type InboundEmailListQuery = z.infer<typeof inboundEmailListQuerySchema>
