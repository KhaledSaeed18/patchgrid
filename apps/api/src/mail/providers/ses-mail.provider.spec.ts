import { SESv2Client } from "@aws-sdk/client-sesv2"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SES_CLIENT_OPTIONS, SesMailProvider } from "./ses-mail.provider"

afterEach(() => vi.restoreAllMocks())

describe("SesMailProvider", () => {
  it("hands SES the raw message, threading and automatic-mail headers intact, and returns its id", async () => {
    const send = vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async () => ({ MessageId: "ses-0001" }))
    const result = await new SesMailProvider().send({
      to: "rita@acme.test",
      from: { name: "Acme IT", address: "notifications@patchgrid.test" },
      replyTo: "acme@inbound.patchgrid.test",
      messageId: "<ticket-42.1@patchgrid.test>",
      headers: { References: "<ticket-42@patchgrid.test>", "Auto-Submitted": "auto-generated" },
      subject: "[INC-000042] Printer on fire",
      html: "<p>Hello</p>",
      text: "Hello",
    })

    expect(send).toHaveBeenCalledOnce()
    const input = (send.mock.calls[0]?.[0] as { input: { Content: { Raw: { Data: Uint8Array } }; Destination?: unknown } }).input
    const raw = Buffer.from(input.Content.Raw.Data).toString("utf8")
    expect(raw).toMatch(/^From: Acme IT <notifications@patchgrid\.test>\r?$/m)
    expect(raw).toMatch(/^Reply-To: acme@inbound\.patchgrid\.test\r?$/m)
    expect(raw).toMatch(/^References: <ticket-42@patchgrid\.test>\r?$/m)
    expect(raw).toMatch(/^Auto-Submitted: auto-generated\r?$/m)
    expect(raw).toMatch(/^Subject: \[INC-000042\] Printer on fire\r?$/m)
    expect(result.providerMessageId).toContain("ses-0001")
  })

  it("bounds every call and leaves the retries to the mail job", async () => {
    expect(SES_CLIENT_OPTIONS).toEqual({ maxAttempts: 1, requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 } })
    const client = new SESv2Client(SES_CLIENT_OPTIONS)
    expect(await client.config.maxAttempts()).toBe(1)
  })

  it("lets SES's refusal propagate, so the mail job retries", async () => {
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async () => {
      throw new Error("Throttling")
    })
    await expect(
      new SesMailProvider().send({
        to: "rita@acme.test",
        from: { name: "Acme IT", address: "notifications@patchgrid.test" },
        subject: "s",
        html: "h",
        text: "t",
      }),
    ).rejects.toThrow("Throttling")
  })
})
