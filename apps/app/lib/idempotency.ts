/**
 * A fresh `Idempotency-Key` (ADR-0012). Not `crypto.randomUUID()`: browsers
 * only offer that in secure contexts, and development serves plain http on
 * lvh.me. `getRandomValues` is available everywhere and is the same entropy.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * A random (version 4) UUID, for the same reason: an id the client chooses,
 * such as a bulk action's operation id (ADR-0052), on plain-http development.
 */
export function newUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
