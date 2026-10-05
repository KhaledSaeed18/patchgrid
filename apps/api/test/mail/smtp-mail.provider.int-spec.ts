/**
 * The SMTP provider against a real Mailpit, found through its HTTP API. Skipped
 * when MAILPIT_URL is not set — the CI schema job has no Mailpit — and said so,
 * rather than passing vacuously.
 */
import "../support/env"

import { randomUUID } from "node:crypto"
import process from "node:process"
import { afterAll, describe, expect, it } from "vitest"

import type { AppConfig } from "../../src/config/app-config"
import { SmtpMailProvider } from "../../src/mail/providers/smtp-mail.provider"

const mailpit = process.env.MAILPIT_URL
const describeIfMailpit = mailpit === undefined || mailpit === "" ? describe.skip : describe

const config = {
  SMTP_HOST: process.env.SMTP_HOST ?? "localhost",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 1025),
} as AppConfig

const address = `probe-${randomUUID().slice(0, 8)}@probe.test`
let messageId = ""

afterAll(async () => {
  if (messageId !== "" && mailpit !== undefined) {
    await fetch(`${mailpit}/api/v1/messages`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ IDs: [messageId] }),
    })
  }
})

describeIfMailpit("SmtpMailProvider against Mailpit", () => {
  it("delivers html and text with the tenant's display name on our envelope address", async () => {
    const provider = new SmtpMailProvider(config)
    const result = await provider.send({
      to: address,
      from: { name: "Acme", address: "notifications@patchgrid.test" },
      subject: "Probe",
      html: "<p>Hello <strong>there</strong></p>",
      text: "Hello there",
    })
    expect(result.providerMessageId).not.toBe("")

    let found: { ID: string; From: { Name: string; Address: string }; Subject: string } | undefined
    for (let attempt = 0; attempt < 20 && found === undefined; attempt += 1) {
      const response = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
      const body = (await response.json()) as { messages: (typeof found)[] }
      found = body.messages[0]
      if (found === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(found).toBeDefined()
    messageId = found?.ID ?? ""
    expect(found?.Subject).toBe("Probe")
    expect(found?.From).toEqual({ Name: "Acme", Address: "notifications@patchgrid.test" })
  })
})
