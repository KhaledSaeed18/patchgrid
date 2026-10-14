import { describe, expect, it } from "vitest"

import { presignAttachmentRequestSchema } from "./attachments.ts"
import { MAX_ATTACHMENT_BYTES } from "./limits.ts"

const base = { ticketId: "0190b2f0-0000-7000-8000-00000000000a", filename: "log.txt", mimeType: "text/plain", sizeBytes: 10 }

describe("a presign request", () => {
  it("takes an allow-listed type at a size up to the ceiling", () => {
    expect(presignAttachmentRequestSchema.safeParse(base).success).toBe(true)
    expect(presignAttachmentRequestSchema.safeParse({ ...base, sizeBytes: MAX_ATTACHMENT_BYTES }).success).toBe(true)
  })

  it("refuses an SVG, HTML, an empty file, one over the ceiling, and an unknown field", () => {
    for (const mimeType of ["image/svg+xml", "text/html", "application/xhtml+xml"]) {
      expect(presignAttachmentRequestSchema.safeParse({ ...base, mimeType }).success, mimeType).toBe(false)
    }
    expect(presignAttachmentRequestSchema.safeParse({ ...base, sizeBytes: 0 }).success).toBe(false)
    expect(presignAttachmentRequestSchema.safeParse({ ...base, sizeBytes: MAX_ATTACHMENT_BYTES + 1 }).success).toBe(false)
    expect(presignAttachmentRequestSchema.safeParse({ ...base, storageKey: "org/x" }).success).toBe(false)
  })
})
