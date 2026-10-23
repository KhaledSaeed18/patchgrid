/**
 * A message as a receiving MTA hands it to us (ADR-0039): RFC 5322 bytes with
 * the receiver's own Authentication-Results on top, posted with a Standard
 * Webhooks signature. Shared by the integration specs and the dev harness
 * (`pnpm --filter @patchgrid/api run inbound:send`), so both speak exactly
 * what a provider adapter must.
 */
import { randomUUID } from "node:crypto"

import { sign } from "../../src/inbound/domain/signature.ts"

export type SampleMail = {
  from: string
  to: string
  subject: string
  text: string
  /** `pass` by default; `fail` is a forged sender, `none` a receiver that said nothing. */
  dmarc?: "pass" | "fail" | "none"
  authservId: string
  messageId?: string
  inReplyTo?: string
  headers?: Record<string, string>
  attachments?: { filename: string; contentType: string; content: Buffer }[]
}

export function buildMessage(mail: SampleMail): Buffer {
  const domain = mail.from.split("@").at(-1) ?? "example.test"
  const boundary = `pg-${randomUUID()}`
  const lines: string[] = []
  if (mail.dmarc !== "none") {
    const result = mail.dmarc ?? "pass"
    lines.push(
      `Authentication-Results: ${mail.authservId}; spf=${result} smtp.mailfrom=${domain}; dkim=${result} header.d=${domain}; dmarc=${result} (p=none) header.from=${domain}`,
    )
  }
  lines.push(
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Message-ID: ${mail.messageId ?? `<${randomUUID()}@${domain}>`}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  )
  if (mail.inReplyTo !== undefined) lines.push(`In-Reply-To: ${mail.inReplyTo}`, `References: ${mail.inReplyTo}`)
  for (const [name, value] of Object.entries(mail.headers ?? {})) lines.push(`${name}: ${value}`)
  const files = mail.attachments ?? []
  if (files.length === 0) {
    lines.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", mail.text)
  } else {
    lines.push(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      mail.text,
    )
    for (const file of files) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${file.contentType}; name="${file.filename}"`,
        `Content-Disposition: attachment; filename="${file.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        file.content.toString("base64").replace(/.{76}/g, "$&\r\n"),
      )
    }
    lines.push(`--${boundary}--`)
  }
  return Buffer.from(lines.join("\r\n"), "utf8")
}

/** The webhook request: its body and the three signature headers. */
export function webhookRequest(secret: string, recipients: string[], raw: Buffer, now = new Date()) {
  const body = Buffer.from(JSON.stringify({ type: "email.received", data: { recipients, raw: raw.toString("base64") } }))
  const id = `msg_${randomUUID()}`
  const timestamp = String(Math.floor(now.getTime() / 1000))
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": sign(secret, id, timestamp, body),
      "content-type": "application/json",
    },
  }
}
