import type { SupportSession, SupportSessionStatus } from "@patchgrid/contracts"

import type { SupportSessionRow } from "./repositories/support-session.repository"

/** A session's status is its timestamps (ADR-0041); an expiry not yet swept already counts. */
export function statusOf(row: Pick<SupportSessionRow, "grantedAt" | "declinedAt" | "expiresAt" | "endedAt">, now: Date): SupportSessionStatus {
  if (row.declinedAt !== null) return "DECLINED"
  if (row.grantedAt === null) return "REQUESTED"
  if (row.endedAt !== null || (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime())) return "ENDED"
  return "ACTIVE"
}

export function toSupportSession(row: SupportSessionRow, now: Date): SupportSession {
  const status = statusOf(row, now)
  return {
    id: row.id,
    status,
    reason: row.reason,
    operator: { name: row.platformAdmin.user.name },
    requestedAt: row.requestedAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    firstUsedAt: row.firstUsedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    // An expiry the sweep has not reached yet is still an expiry.
    endReason: row.endReason ?? (status === "ENDED" ? "EXPIRED" : null),
  }
}
