import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
  type AttachmentMimeType,
  attachmentSchema,
  MAX_ATTACHMENT_BYTES,
  presignedUploadSchema,
} from "@patchgrid/contracts"

import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"

/** The browser's word for what a file is, kept only if it is on the allow-list. */
export function allowedType(file: { type: string }): AttachmentMimeType | null {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(
    file.type
  )
    ? (file.type as AttachmentMimeType)
    : null
}

/**
 * Why a file cannot be attached, in words, or `null` when it may be tried.
 * The server decides — it sniffs the bytes — this only spares a round trip
 * for a file that could never pass.
 */
export function fileProblem(file: {
  name: string
  type: string
  size: number
}): string | null {
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > MAX_ATTACHMENT_BYTES)
    return `${file.name} is larger than ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`
  if (allowedType(file) === null)
    return `${file.name} isn't a type that can be attached: images, PDFs, text, CSV, JSON, Office documents and zip files can.`
  return null
}

/** For a test to stand in for `fetch` against storage. */
export type Put = (url: string, init: RequestInit) => Promise<Response>

/**
 * Attach one file (ADR-0005): presign, PUT the bytes straight to the files
 * domain with exactly the headers the presign named, then complete — where
 * the server sniffs the bytes and may refuse them.
 */
export async function uploadAttachment(
  target: { ticketId: string; commentId?: string },
  file: File,
  put: Put = (url, init) => fetch(url, init)
): Promise<Attachment> {
  const mimeType = allowedType(file)
  if (mimeType === null) throw new Error(fileProblem(file) ?? "Not allowed")
  const presigned = await clientApi("/attachments", {
    method: "POST",
    body: {
      ticketId: target.ticketId,
      ...(target.commentId === undefined
        ? {}
        : { commentId: target.commentId }),
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
    },
    schema: presignedUploadSchema,
    idempotencyKey: newIdempotencyKey(),
  })
  const stored = await put(presigned.upload.url, {
    method: "PUT",
    headers: presigned.upload.headers,
    body: file,
  })
  if (!stored.ok) throw new Error(`${file.name} didn't upload. Try again.`)
  try {
    return await clientApi(`/attachments/${presigned.attachment.id}/complete`, {
      method: "POST",
      schema: attachmentSchema,
    })
  } catch (error) {
    // The server sniffed the bytes and said why it refused them; say it about this file.
    const reason =
      error instanceof ApiError ? error.fieldError("file") : undefined
    throw reason === undefined ? error : new Error(`${file.name} ${reason}.`)
  }
}

/** What to tell someone whose file did not attach: the server's reason, or the upload's own. */
export function uploadFailure(error: unknown, filename: string): string {
  if (error instanceof ApiError)
    return failureMessage(error, `${filename} wasn't attached.`)
  return error instanceof Error ? error.message : `${filename} wasn't attached.`
}

/** A size people read: "812 KB", "3.4 MB". */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
