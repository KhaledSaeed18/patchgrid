import { z } from "zod"

import { idSchema } from "./id.ts"
import { ALLOWED_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_BYTES } from "./limits.ts"

/** An upload's life (ADR-0005). Storage twin: Prisma's `AttachmentStatus`. */
export const attachmentStatusSchema = z.enum(["PENDING", "READY"])
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>

/** Only the allow-listed types are ever asked for; byte sniffing then decides what the file really is. */
export const attachmentMimeTypeSchema = z.enum(ALLOWED_ATTACHMENT_MIME_TYPES)

/**
 * `POST /attachments`: what the browser is about to upload. The size is
 * signed into the upload exactly, so the bytes cannot be more than said.
 * Without `commentId` the file belongs to the ticket; with one, to that
 * comment, whose visibility it then shares.
 */
export const presignAttachmentRequestSchema = z.strictObject({
  ticketId: idSchema,
  commentId: idSchema.optional(),
  filename: z.string().trim().min(1).max(255),
  mimeType: attachmentMimeTypeSchema,
  sizeBytes: z
    .int()
    .positive()
    .max(MAX_ATTACHMENT_BYTES, { error: `must be at most ${String(MAX_ATTACHMENT_BYTES)} bytes` }),
})
export type PresignAttachmentRequest = z.infer<typeof presignAttachmentRequestSchema>

/** One file as a ticket lists it. `mimeType` is what sniffing found once `READY`. */
export const attachmentSchema = z.object({
  id: idSchema,
  ticketId: idSchema,
  commentId: idSchema.nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.int().positive(),
  status: attachmentStatusSchema,
  uploader: z.object({ membershipId: idSchema, displayName: z.string() }),
  createdAt: z.iso.datetime(),
  /** Whether this actor may remove it, decided by the server (RBAC.md §6). */
  canDelete: z.boolean(),
})
export type Attachment = z.infer<typeof attachmentSchema>

/**
 * The answer to a presign: the row, and the one PUT that may fill it — to
 * the attachments domain (ADR-0037), with exactly these headers, before
 * `expiresAt`. Then `POST /attachments/:id/complete`.
 */
export const presignedUploadSchema = z.object({
  attachment: attachmentSchema,
  upload: z.object({
    method: z.literal("PUT"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  }),
})
export type PresignedUpload = z.infer<typeof presignedUploadSchema>

/** `GET /attachments/:id/download`: a short-lived link; `inline` only for the raster allow-list. */
export const attachmentDownloadSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
  inline: z.boolean(),
})
export type AttachmentDownload = z.infer<typeof attachmentDownloadSchema>
