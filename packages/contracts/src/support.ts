import { z } from "zod"

import { idSchema } from "./id.ts"
import type { Permission } from "./permissions.ts"

/**
 * Consent-based support access (ADR-0020, ADR-0041): an operator asks, an
 * owner grants for at most 72 hours, and the operator reads the workspace
 * through its own routes as a read-only support actor — every request in the
 * workspace's own audit log.
 */

export const MAX_SUPPORT_HOURS = 72

/**
 * Exactly an `ADMIN`'s read permissions minus `token:read` (ADR-0020). It
 * deliberately includes internal notes and the audit log — a session that
 * cannot see them cannot diagnose anything — and the consent screen says so.
 */
export const SUPPORT_READ_PERMISSIONS = [
  "ticket:read",
  "ticket:read_audit",
  "comment:read_internal",
  "attachment:download",
  "asset:read",
  "asset:read_all",
  "kb:read_published",
  "kb:read_internal",
  "kb:read_draft",
  "member:read",
  "member:read_contact",
  "team:read",
  "category:read",
  "sla:read",
  "automation:read",
  "org:read_settings",
  "org:read_audit",
] as const satisfies readonly Permission[]

export const supportSessionStatusSchema = z.enum([
  "REQUESTED",
  "DECLINED",
  "ACTIVE",
  "ENDED",
])
export type SupportSessionStatus = z.infer<typeof supportSessionStatusSchema>

export const supportEndReasonSchema = z.enum([
  "EXPIRED",
  "REVOKED",
  "AUDIT_FAILED",
])
export type SupportEndReason = z.infer<typeof supportEndReasonSchema>

export const supportSessionSchema = z.object({
  id: idSchema,
  status: supportSessionStatusSchema,
  reason: z.string(),
  /** The operator, by name — the workspace sees who asked. */
  operator: z.object({ name: z.string() }),
  requestedAt: z.iso.datetime(),
  grantedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  firstUsedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  endReason: supportEndReasonSchema.nullable(),
})
export type SupportSession = z.infer<typeof supportSessionSchema>

/** An operator asks, saying why; the owners read the reason before deciding. */
export const requestSupportRequestSchema = z.strictObject({
  reason: z.string().trim().min(10).max(500),
})
export type RequestSupportRequest = z.infer<typeof requestSupportRequestSchema>

export const grantSupportRequestSchema = z.strictObject({
  hours: z.int().min(1).max(MAX_SUPPORT_HOURS),
})
export type GrantSupportRequest = z.infer<typeof grantSupportRequestSchema>

/** What a member's `/me` says about support while it matters (ADR-0041). */
export const supportStateSchema = z.discriminatedUnion("kind", [
  /** This browser IS the support session: read-only, everything recorded. */
  z.object({
    kind: z.literal("operator"),
    sessionId: idSchema,
    operatorName: z.string(),
    expiresAt: z.iso.datetime(),
  }),
  /** An admin or owner looking at their own workspace while an operator can read it. */
  z.object({
    kind: z.literal("watched"),
    sessionId: idSchema,
    operatorName: z.string(),
    expiresAt: z.iso.datetime(),
  }),
])
export type SupportState = z.infer<typeof supportStateSchema>
