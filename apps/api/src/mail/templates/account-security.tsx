import { MailLayout } from "./layout"

export type AccountSecurityEvent = "factor-enabled" | "factor-disabled" | "factor-locked" | "recovery-code-used" | "recovery-codes-regenerated"

export type AccountSecurityParams = { event: AccountSecurityEvent; remaining: number }

const HEADLINE: Record<AccountSecurityEvent, string> = {
  "factor-enabled": "Two-factor authentication is on for your Patchgrid account",
  "factor-disabled": "Two-factor authentication was turned off for your Patchgrid account",
  "factor-locked": "Your Patchgrid second factor is locked for an hour",
  "recovery-code-used": "A recovery code was used to sign in to your Patchgrid account",
  "recovery-codes-regenerated": "Your Patchgrid recovery codes were replaced",
}

export function accountSecuritySubject(p: AccountSecurityParams): string {
  return HEADLINE[p.event]
}

/**
 * To the person, whenever their second factor changes or comes under attack
 * (ADR-0029, ADR-0045). Every line ends the same way: if it was not you, the
 * password is known to someone else.
 */
export function AccountSecurity(p: AccountSecurityParams) {
  return (
    <MailLayout preview={HEADLINE[p.event]}>
      <p>
        <strong>{HEADLINE[p.event]}.</strong>
      </p>
      {p.event === "factor-enabled" && <p>From now on, signing in takes your password and a code from your authenticator app. You were shown {p.remaining} recovery codes; keep them somewhere safe.</p>}
      {p.event === "factor-disabled" && <p>Your password alone signs you in again. Workspaces that require a second factor will ask you to set one up before they open.</p>}
      {p.event === "factor-locked" && <p>Five wrong codes were entered after your password. If that was not you, someone has your password: change it now.</p>}
      {p.event === "recovery-code-used" && (
        <p>
          {p.remaining} recovery code{p.remaining === 1 ? "" : "s"} left. Every other session you had was signed out. If this was not you, someone has your password and a
          recovery code: change the password, then turn two-factor authentication off and on again to get new codes.
        </p>
      )}
      {p.event === "recovery-codes-regenerated" && <p>The old codes no longer work. {p.remaining} new ones were shown to you once.</p>}
      <p>If this was not you, change your password straight away.</p>
    </MailLayout>
  )
}
