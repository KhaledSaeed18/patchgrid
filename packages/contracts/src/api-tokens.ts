import { z } from "zod"

import { idSchema } from "./id.ts"
import { tokenScopeSchema } from "./permissions.ts"

/**
 * API tokens (ADR-0021, ADR-0042). A token is `pg_<prefix>_<secret>`: the
 * prefix is public and names the token in logs; the secret is shown once, in
 * the answer to its creation, and never again.
 */
export const API_TOKEN_PATTERN = /^pg_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/

/** How long a token may live; `null` is until revoked. */
export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const

/** The scopes a token can be given. `webhooks:write` is reserved and grants nothing yet. */
export const offeredTokenScopeSchema = tokenScopeSchema.exclude(["webhooks:write"])
export type OfferedTokenScope = z.infer<typeof offeredTokenScopeSchema>

/** A token acts as a service account with one of these roles, fixed at creation. */
export const apiTokenRoleSchema = z.enum(["AGENT", "REQUESTER"])
export type ApiTokenRole = z.infer<typeof apiTokenRoleSchema>

export const createApiTokenRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  role: apiTokenRoleSchema,
  scopes: z
    .array(offeredTokenScopeSchema)
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, "lists a scope twice"),
  expiresInDays: z.union(API_TOKEN_EXPIRY_DAYS.map((days) => z.literal(days))).nullable(),
})
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>

export const apiTokenStatusSchema = z.enum(["ACTIVE", "EXPIRED", "REVOKED"])
export type ApiTokenStatus = z.infer<typeof apiTokenStatusSchema>

export const apiTokenSchema = z.object({
  id: idSchema,
  name: z.string(),
  prefix: z.string(),
  role: apiTokenRoleSchema,
  scopes: z.array(tokenScopeSchema),
  status: apiTokenStatusSchema,
  /** The service account the token acts as; it appears in the member list. */
  membershipId: idSchema,
  createdBy: z.object({ id: idSchema, displayName: z.string() }),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
})
export type ApiToken = z.infer<typeof apiTokenSchema>

/** The answer to creation: the only time the secret exists outside the caller. */
export const createdApiTokenSchema = z.object({
  token: apiTokenSchema,
  secret: z.string().regex(API_TOKEN_PATTERN),
})
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>
