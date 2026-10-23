import { MailLayout } from "./layout"

export type PlatformSecurityEvent = "factor-locked" | "recovery-code-used"

export type PlatformSecurityParams = { event: PlatformSecurityEvent; remaining: number }

const HEADLINE: Record<PlatformSecurityEvent, string> = {
  "factor-locked": "Your Patchgrid operator sign-in is locked for an hour",
  "recovery-code-used": "A recovery code was used to sign in to Patchgrid operations",
}

export function platformSecuritySubject(p: PlatformSecurityParams): string {
  return HEADLINE[p.event]
}

/**
 * To the operator, when their second factor is under attack or a recovery
 * code was spent (ADR-0029, ADR-0040). If it was not them, the password is
 * known to someone else.
 */
export function PlatformSecurity(p: PlatformSecurityParams) {
  return (
    <MailLayout preview={HEADLINE[p.event]}>
      <p>
        <strong>{HEADLINE[p.event]}.</strong>
      </p>
      {p.event === "factor-locked" ? (
        <p>
          Five wrong codes were entered after your password. If that was not you, someone has your password: change it, and tell whoever
          runs the platform.
        </p>
      ) : (
        <p>
          {p.remaining} recovery code{p.remaining === 1 ? "" : "s"} left. Every other operator session you had was signed out. If this was
          not you, someone has your password and a recovery code: change the password, and have your grant revoked.
        </p>
      )}
    </MailLayout>
  )
}
