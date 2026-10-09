/**
 * A fresh `Idempotency-Key` (ADR-0012). Not `crypto.randomUUID()`: browsers
 * only offer that in secure contexts, and development serves plain http on
 * lvh.me. `getRandomValues` is available everywhere and is the same entropy.
 */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
