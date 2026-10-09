import { z } from "zod"

import { idSchema } from "./id.ts"
import { roleSchema } from "./tenancy.ts"

/**
 * Teams (ADR-0025, RBAC.md §3). A member may be in several teams; a team has
 * at most one lead. Teams are deactivated, never deleted — tickets will
 * reference them. Names are unique per organization.
 */

export const teamNameSchema = z.string().trim().min(1).max(60)

export const teamSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  memberCount: z.int().nonnegative(),
  lead: z.object({ membershipId: idSchema, displayName: z.string() }).nullable(),
})
export type Team = z.infer<typeof teamSchema>

export const teamMemberSchema = z.object({
  membershipId: idSchema,
  displayName: z.string(),
  role: roleSchema,
  isLead: z.boolean(),
  joinedAt: z.iso.datetime(),
})
export type TeamMember = z.infer<typeof teamMemberSchema>

export const teamDetailSchema = teamSchema.extend({ members: z.array(teamMemberSchema) })
export type TeamDetail = z.infer<typeof teamDetailSchema>

export const createTeamRequestSchema = z.object({
  name: teamNameSchema,
  description: z.string().trim().max(500).optional(),
})
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>

export const updateTeamRequestSchema = z
  .object({
    name: teamNameSchema,
    description: z.string().trim().max(500).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { error: "must change at least one field" })
export type UpdateTeamRequest = z.infer<typeof updateTeamRequestSchema>

/** `null` clears the lead. The lead must already be in the team and hold `AGENT` or above. */
export const setTeamLeadRequestSchema = z.object({ membershipId: idSchema.nullable() })
export type SetTeamLeadRequest = z.infer<typeof setTeamLeadRequestSchema>
