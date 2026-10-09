import { z } from "zod"

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
])
export type AuditAction = z.infer<typeof auditActionSchema>

/** Who performed an audited change — never a colleague's name on a machine's change. */
export const auditActorKindSchema = z.enum(["MEMBER", "SERVICE", "SYSTEM", "PLATFORM"])
export type AuditActorKind = z.infer<typeof auditActorKindSchema>
