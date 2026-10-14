import { z } from "zod"

import { idSchema } from "./id.ts"

/** The archive's own version, written into its manifest (ADR-0044). */
export const EXPORT_FORMAT_VERSION = 1
/** How long a ready export's link lasts, and how long an owner waits between exports (ADR-0028). */
export const EXPORT_LINK_HOURS = 24
export const EXPORT_COOLDOWN_HOURS = 24

export const orgExportStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "READY",
  "FAILED",
  "EXPIRED",
])
export type OrgExportStatus = z.infer<typeof orgExportStatusSchema>

/** One export of the workspace, as Settings lists it. */
export const orgExportSchema = z.object({
  id: idSchema,
  status: orgExportStatusSchema,
  requestedBy: z.object({ id: idSchema, displayName: z.string() }),
  requestedAt: z.iso.datetime(),
  readyAt: z.iso.datetime().nullable(),
  /** When the link — and the zip behind it — lapse. */
  expiresAt: z.iso.datetime().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  failure: z.string().nullable(),
})
export type OrgExport = z.infer<typeof orgExportSchema>

/** A short-lived link to a ready export's zip. */
export const exportDownloadSchema = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
})
export type ExportDownload = z.infer<typeof exportDownloadSchema>

/** Erasing one's own account asks for the password again (ADR-0044). */
export const eraseAccountRequestSchema = z.strictObject({
  password: z.string().min(1).max(1024),
})
export type EraseAccountRequest = z.infer<typeof eraseAccountRequestSchema>
