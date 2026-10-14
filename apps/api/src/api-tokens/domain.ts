import { type ApiToken, type ApiTokenStatus, apiTokenRoleSchema, type TokenScope, tokenScopeSchema } from "@patchgrid/contracts"
import { randomBytes, randomInt } from "node:crypto"
import { z } from "zod"

import type { ApiTokenRow } from "./repositories/api-token.repository"

const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const PREFIX_LENGTH = 12
const SECRET_BYTES = 32

/**
 * A new token (ADR-0042): `pg_<prefix>_<secret>`. The prefix is twelve random
 * `[a-z0-9]` — public, unique, safe to log; the secret is 32 random bytes,
 * whose hash is all that is kept.
 */
export function mintToken(): { prefix: string; secret: string; token: string } {
  const prefix = Array.from({ length: PREFIX_LENGTH }, () => PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)]).join("")
  const secret = randomBytes(SECRET_BYTES).toString("base64url")
  return { prefix, secret, token: `pg_${prefix}_${secret}` }
}

export function statusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): ApiTokenStatus {
  if (row.revokedAt !== null) return "REVOKED"
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return "EXPIRED"
  return "ACTIVE"
}

const scopesSchema = z.array(tokenScopeSchema)

/** The stored scopes, held to the catalog: the CHECK constraint says the same. */
export function scopesOf(stored: string[]): TokenScope[] {
  return scopesSchema.parse(stored)
}

export function toApiToken(row: ApiTokenRow, now: Date): ApiToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    role: apiTokenRoleSchema.parse(row.membership.role),
    scopes: scopesOf(row.scopes),
    status: statusOf(row, now),
    membershipId: row.membershipId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}
