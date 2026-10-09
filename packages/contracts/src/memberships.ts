import { z } from "zod"

import { emailSchema, passwordSchema } from "./auth.ts"
import { idSchema } from "./id.ts"
import { pageSchema, paginationQuerySchema } from "./pagination.ts"
import { slugSchema } from "./slug.ts"
import { membershipKindSchema, membershipStatusSchema, roleSchema } from "./tenancy.ts"

/**
 * Members and invitations (ADR-0033, TENANCY.md §5, RBAC.md §6).
 *
 * A member's contact details — email and last login — are present only for a
 * caller holding `member:read_contact`; everyone else sees the display name and
 * avatar (`member:read`). `null` there means "not yours to see", never "unknown".
 */

export const memberSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: roleSchema,
  status: membershipStatusSchema,
  kind: membershipKindSchema,
  joinedAt: z.iso.datetime().nullable(),
  teams: z.array(z.object({ id: idSchema, name: z.string(), isLead: z.boolean() })),
  contact: z.object({ email: emailSchema.nullable(), lastLoginAt: z.iso.datetime().nullable() }).nullable(),
})
export type Member = z.infer<typeof memberSchema>

export const memberPageSchema = pageSchema(memberSchema)
export type MemberPage = z.infer<typeof memberPageSchema>

export const memberListQuerySchema = paginationQuerySchema.extend({
  /** Removed members are hidden unless asked for, and only an admin may ask (ADR-0033). */
  includeRemoved: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
})
export type MemberListQuery = z.infer<typeof memberListQuerySchema>

export const changeRoleRequestSchema = z.object({ role: roleSchema })
export type ChangeRoleRequest = z.infer<typeof changeRoleRequestSchema>

export const invitationSchema = z.object({
  id: idSchema,
  email: emailSchema,
  role: roleSchema,
  teamId: idSchema.nullable(),
  invitedByMembershipId: idSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
})
export type Invitation = z.infer<typeof invitationSchema>

export const createInvitationRequestSchema = z.object({
  email: emailSchema,
  role: roleSchema,
  /** The one team the member starts in. */
  teamId: idSchema.optional(),
})
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>

/** The token is opaque to clients; a malformed one is the same 404 as a wrong one (ADR-0033). */
export const invitationTokenQuerySchema = z.object({ token: z.string().max(200) })

/**
 * What the acceptance page shows before the holder commits. `accountExists`
 * picks between "sign in to accept" and "create your account" — disclosed only
 * to someone holding a valid token for that address (ADR-0033).
 */
export const invitationPreviewSchema = z.object({
  organization: z.object({ name: z.string(), slug: slugSchema }),
  role: roleSchema,
  accountExists: z.boolean(),
})
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>

export const acceptInvitationRequestSchema = z.object({ token: z.string().max(200) })
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>

/** Accepting with no account yet: the link proves the inbox, so the account starts verified. */
export const acceptNewInvitationRequestSchema = z.object({
  token: z.string().max(200),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
})
export type AcceptNewInvitationRequest = z.infer<typeof acceptNewInvitationRequestSchema>

export const acceptInvitationResponseSchema = z.object({
  organization: z.object({ id: idSchema, name: z.string(), slug: slugSchema }),
  membershipId: idSchema,
  /** The workspace whose cookie pair the response set. */
  session: z.object({ slug: slugSchema }),
})
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>
