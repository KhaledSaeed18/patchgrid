import type { AuditEntry } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { withoutInternalText } from "./ticket-audit.service"

const entry = (diff: Record<string, unknown>): AuditEntry =>
  ({
    id: "a",
    action: "COMMENT_EDITED",
    entityType: "Ticket",
    entityId: "t",
    diff,
    actor: null,
    createdAt: "2026-10-15T12:00:00.000Z",
  }) as unknown as AuditEntry

describe("withoutInternalText", () => {
  it("strips an internal note's words and files, and an entry that never said it was public", () => {
    expect(withoutInternalText(entry({ commentId: "c", previousBody: "secret", internal: true })).diff).toEqual({
      commentId: "c",
      internal: true,
      redacted: true,
    })
    expect(withoutInternalText(entry({ attachmentId: "x", filename: "keys.txt" })).diff).toEqual({ attachmentId: "x", redacted: true })
  })

  it("keeps what was public, and entries that carry no words at all", () => {
    const pub = entry({ commentId: "c", previousBody: "hello", internal: false })
    expect(withoutInternalText(pub)).toBe(pub)
    const status = entry({ status: { from: "NEW", to: "OPEN" } })
    expect(withoutInternalText(status)).toBe(status)
  })
})
