import { Secret, TOTP } from "otpauth"

/** RFC 6238 as every authenticator app speaks it: SHA-1, six digits, thirty seconds. */
const PERIOD_SECONDS = 30

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32
}

/** What a QR code carries: `otpauth://totp/Patchgrid:<label>?secret=…&issuer=Patchgrid`. */
export function otpauthUri(secret: string, label: string): string {
  return totp(secret, label).toString()
}

/** The 30-second step a moment falls in — what is stored so a code is never accepted twice. */
export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / PERIOD_SECONDS)
}

/**
 * The step this code is valid for — its own, or one either side for clock
 * drift — or `null`. A step at or before `lastUsedStep` is refused: a code
 * seen once is spent, even inside its window.
 */
export function acceptedStep(secret: string, code: string, now: Date, lastUsedStep: number | null): number | null {
  const delta = totp(secret, "").validate({ token: code, timestamp: now.getTime(), window: 1 })
  if (delta === null) return null
  const step = stepAt(now) + delta
  return lastUsedStep !== null && step <= lastUsedStep ? null : step
}

/** For tests and the dev harness only: the code an authenticator would show at `now`. */
export function codeAt(secret: string, now: Date): string {
  return totp(secret, "").generate({ timestamp: now.getTime() })
}

function totp(secret: string, label: string): TOTP {
  return new TOTP({ issuer: "Patchgrid", label, algorithm: "SHA1", digits: 6, period: PERIOD_SECONDS, secret: Secret.fromBase32(secret) })
}
