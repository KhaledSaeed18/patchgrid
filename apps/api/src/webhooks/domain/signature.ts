import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * The Standard Webhooks signature (ADR-0050): HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the secret's bytes, sent as
 * `v1,<base64>`. Several signatures, space-separated, while a rotated secret
 * is still honoured.
 */
const PREFIX = "whsec_"

/** A new secret: `whsec_` and base64 of 24 random bytes. */
export function newWebhookSecret(): string {
  return `${PREFIX}${randomBytes(24).toString("base64")}`
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(PREFIX)) throw new Error("a webhook secret starts with whsec_")
  return Buffer.from(secret.slice(PREFIX.length), "base64")
}

export function sign(secret: string, id: string, timestampSeconds: number, body: string): string {
  return `v1,${createHmac("sha256", keyOf(secret))
    .update(`${id}.${String(timestampSeconds)}.${body}`)
    .digest("base64")}`
}

/** The three headers of one attempt, signed with every secret still in force. */
export function signatureHeaders(secrets: readonly string[], id: string, timestampSeconds: number, body: string): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": secrets.map((secret) => sign(secret, id, timestampSeconds, body)).join(" "),
  }
}

/**
 * What a receiver does, for the tests and the docs: any listed signature that
 * matches, compared in constant time, within the tolerance of the timestamp.
 */
export function verify(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const timestamp = Number(headers.timestamp)
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(sign(secret, headers.id, timestamp, body))
  return headers.signature.split(" ").some((candidate) => {
    const given = Buffer.from(candidate)
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
