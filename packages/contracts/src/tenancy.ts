import { z } from "zod"

import { slugSchema } from "./slug.ts"

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

/** ADR-0033: `INVITED` is not produced in v1; `REMOVED` is terminal and keeps history attributed. */
export const membershipStatusSchema = z.enum(["ACTIVE", "INVITED", "DISABLED", "REMOVED"])
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

/**
 * `GET /tenants/:slug` — what a subdomain should do before any session exists
 * (TENANCY.md §2). Consumed by `apps/app`'s host parsing: `active` renders the
 * workspace, `moved` is a **302** to `currentSlug` (never a 301 — nothing that
 * permanent should describe a mutable mapping), `suspended` is the 403 page.
 * Unknown, pending-deletion and retired-past-the-window slugs are a `404`.
 *
 * Deliberately public: slug existence is accepted risk R-2 in the threat model.
 */
export const tenantLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), slug: slugSchema }),
  z.object({ status: z.literal("suspended"), slug: slugSchema }),
  z.object({ status: z.literal("moved"), slug: slugSchema, currentSlug: slugSchema }),
])
export type TenantLookup = z.infer<typeof tenantLookupSchema>
