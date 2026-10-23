import { describe, expect, it } from "vitest"

import { inboundAddress, inboundWebhookSchema } from "./inbound.ts"
import { RESERVED_SLUGS } from "./reserved-slugs.ts"

describe("the inbound address", () => {
  it("is the slug at the inbound host, which no tenant can claim", () => {
    expect(inboundAddress("acme", "patchgrid.xyz")).toBe("acme@inbound.patchgrid.xyz")
    expect(RESERVED_SLUGS).toContain("inbound")
  })
})

describe("the webhook body", () => {
  const raw = Buffer.from("From: a@b.c\r\n\r\nhi").toString("base64")

  it("takes envelope recipients, lower-cased, and base64 bytes", () => {
    const parsed = inboundWebhookSchema.parse({ type: "email.received", data: { recipients: [" Acme@Inbound.lvh.me "], raw } })
    expect(parsed.data.recipients).toEqual(["acme@inbound.lvh.me"])
  })

  it("refuses another event, no recipient, and text that is not base64", () => {
    expect(inboundWebhookSchema.safeParse({ type: "email.sent", data: { recipients: ["a@b"], raw } }).success).toBe(false)
    expect(inboundWebhookSchema.safeParse({ type: "email.received", data: { recipients: [], raw } }).success).toBe(false)
    expect(inboundWebhookSchema.safeParse({ type: "email.received", data: { recipients: ["a@b"], raw: "not base64!" } }).success).toBe(
      false,
    )
  })
})
