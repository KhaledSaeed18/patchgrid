import type { OrgExport } from "@patchgrid/contracts"

import type { OrgExportRow } from "./repositories/org-export.repository"

export function toOrgExport(row: OrgExportRow): OrgExport {
  return {
    id: row.id,
    status: row.status,
    requestedBy: { id: row.requestedBy.id, displayName: row.requestedBy.displayName },
    requestedAt: row.requestedAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    failure: row.failure,
  }
}

/** `12.4 MB`, for a person. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
