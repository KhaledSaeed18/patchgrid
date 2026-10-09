import { randomBytes } from "node:crypto"

/**
 * Invitation tokens are `<orgId in base36>.<secret>` (TENANCY.md §5). The org
 * part lets acceptance open the tenant context BEFORE reading the tenant-owned
 * `Invitation` row (ADR-0022); the secret is 256 random bits, stored only as
 * its SHA-256. Neither part is meaningful to a client.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TOKEN = /^([0-9a-z]{1,25})\.([A-Za-z0-9_-]{43})$/

export type ParsedInvitationToken = { orgId: string; secret: string }

export function newInvitationToken(orgId: string): { token: string; secret: string } {
  if (!UUID.test(orgId)) throw new Error("orgId must be a lower-case uuid")
  const secret = randomBytes(32).toString("base64url")
  return { token: `${BigInt(`0x${orgId.replaceAll("-", "")}`).toString(36)}.${secret}`, secret }
}

/** `null` for anything that is not a well-formed token — the caller answers it like a wrong one. */
export function parseInvitationToken(token: string): ParsedInvitationToken | null {
  const match = TOKEN.exec(token)
  if (match === null) return null
  const [, org = "", secret = ""] = match
  let value = 0n
  for (const digit of org) value = value * 36n + BigInt(parseInt(digit, 36))
  if (value >= 1n << 128n) return null
  const hex = value.toString(16).padStart(32, "0")
  const orgId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  return { orgId, secret }
}
