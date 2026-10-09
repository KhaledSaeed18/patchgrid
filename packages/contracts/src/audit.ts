import { z } from "zod"

import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"

/**
 * The audit catalogue (DOMAIN.md §7, RBAC.md §12). Stored as a string so it
 * grows without a migration, and validated here so it cannot grow by typo.
 * Ticket actions join with the ticket module in M2.
 */
export const auditActionSchema = z.enum([
  "MEMBER_INVITED",
  "INVITATION_REVOKED",
  "MEMBER_JOINED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_DISABLED",
  "MEMBER_ENABLED",
  "MEMBER_REMOVED",
  "TEAM_CREATED",
  "TEAM_UPDATED",
  "TEAM_DELETED",
  "TEAM_MEMBER_ADDED",
  "TEAM_MEMBER_REMOVED",
  "TEAM_LEAD_CHANGED",
  "ORG_SETTINGS_UPDATED",
  "ORG_SLUG_CHANGED",
  "AGENT_VISIBILITY_CHANGED",
  "SLA_POLICY_CHANGED",
])
export type AuditAction = z.infer<typeof auditActionSchema>

/** Who performed an audited change — never a colleague's name on a machine's change. */
export const auditActorKindSchema = z.enum(["MEMBER", "SERVICE", "SYSTEM", "PLATFORM"])
export type AuditActorKind = z.infer<typeof auditActorKindSchema>

/** One row of `GET /org/audit` (RBAC.md §12): what changed, on what, by whom, when. */
export const auditEntrySchema = z.object({
  id: idSchema,
  action: auditActionSchema,
  entityType: z.string(),
  entityId: idSchema,
  diff: z.record(z.string(), z.unknown()),
  actor: z.object({
    kind: auditActorKindSchema,
    membershipId: idSchema.nullable(),
    /** The member's name as it is now; a removed member keeps theirs (ADR-0033). */
    displayName: z.string().nullable(),
  }),
  createdAt: z.iso.datetime(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

export const auditPageSchema = pageSchema(auditEntrySchema)
export type AuditPage = z.infer<typeof auditPageSchema>

/**
 * Newest first. Every filter has an index behind it (ARCHITECTURE.md
 * §Indexes): actor, action and the date range; a date range also lets the
 * planner skip whole monthly partitions.
 */
export const auditQuerySchema = paginationQuerySchema
  .extend({
    actorMembershipId: idSchema.optional(),
    action: auditActionSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, {
    error: "`from` must be before `to`",
    path: ["from"],
  })
export type AuditQuery = z.infer<typeof auditQuerySchema>
