import { z } from "zod"

/**
 * Tenancy and membership enums on the wire.
 *
 * Declared here rather than imported from Prisma, so the wire contract does not
 * depend on the storage schema. The two are asserted identical at compile time by
 * `apps/api/src/common/enum-parity.spec.ts` — adding a value to one and not the
 * other fails `pnpm typecheck`.
 */

/** Cumulative: REQUESTER ⊂ AGENT ⊂ ADMIN ⊂ OWNER (RBAC.md §3). Lives on a membership, never a user. */
export const roleSchema = z.enum(["OWNER", "ADMIN", "AGENT", "REQUESTER"])
export type Role = z.infer<typeof roleSchema>

export const membershipStatusSchema = z.enum(["ACTIVE", "INVITED", "DISABLED"])
export type MembershipStatus = z.infer<typeof membershipStatusSchema>

/** A service account is the actor behind an API token (ADR-0021). */
export const membershipKindSchema = z.enum(["HUMAN", "SERVICE_ACCOUNT"])
export type MembershipKind = z.infer<typeof membershipKindSchema>

/** `SUSPENDED` is `403`, never `402` — `402` means a plan limit and nothing else. */
export const organizationStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "PENDING_DELETION"])
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>

export const planSchema = z.enum(["FREE", "PRO"])
export type Plan = z.infer<typeof planSchema>

/** What an AGENT may read (RBAC.md §4). Admins and owners always see everything. */
export const agentVisibilitySchema = z.enum(["ALL_TICKETS", "OWN_TEAM_ONLY"])
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>
