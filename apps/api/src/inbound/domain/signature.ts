import { createHmac, timingSafeEqual } from "node:crypto"

/** How far a webhook's timestamp may be from now, either way (Standard Webhooks). */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export type SignedHeaders = { id: string | undefined; timestamp: string | undefined; signature: string | undefined }

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing" | "stale" | "mismatch" }

function key(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64")
}

/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">` — the Standard Webhooks scheme (ADR-0039). */
export function sign(secret: string, id: string, timestamp: string, body: Buffer): string {
  const mac = createHmac("sha256", key(secret)).update(`${id}.${timestamp}.`).update(body).digest("base64")
  return `v1,${mac}`
}

/**
 * Whether these bytes were signed with this secret, recently. Checked over
 * the raw body before anything parses it; several space-separated signatures
 * are allowed, so a secret can be rotated with both live.
 */
export function verifySignature(secret: string, headers: SignedHeaders, body: Buffer, now: Date): SignatureCheck {
  const { id, timestamp, signature } = headers
  if (id === undefined || timestamp === undefined || signature === undefined || !/^\d{1,12}$/.test(timestamp)) {
    return { ok: false, reason: "missing" }
  }
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" }
  const expected = Buffer.from(sign(secret, id, timestamp, body))
  const matches = signature
    .split(" ")
    .map((candidate) => Buffer.from(candidate.trim()))
    .some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected))
  return matches ? { ok: true } : { ok: false, reason: "mismatch" }
}
