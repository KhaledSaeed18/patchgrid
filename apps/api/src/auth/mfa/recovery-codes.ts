import { randomBytes } from "node:crypto"

/** Ten single-use codes, shown once (ADR-0029). */
export const RECOVERY_CODES = 10

/** `abcde-fghij`: ten base32 letters, easy to read off paper. */
export function recoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  const bytes = randomBytes(10)
  const letters = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
  return `${letters.slice(0, 5)}-${letters.slice(5)}`
}

export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, recoveryCode)
}

/** What is hashed and compared: case and separators are presentation. */
export function normaliseRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, "")
}
