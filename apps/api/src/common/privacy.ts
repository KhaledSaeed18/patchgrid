import { createHash } from "node:crypto"

/**
 * No PII in logs (ENGINEERING.md §Logging). An address is never logged; its
 * truncated SHA-256 is, so abuse against one account is still correlatable
 * across lines without the log ever holding the address.
 */
export function emailHash8(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 8)
}
