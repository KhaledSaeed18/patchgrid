import { MailLayout } from "./layout"

export const ACCOUNT_SECURITY_EVENTS = [
  "factor-enabled",
  "factor-disabled",
  "factor-locked",
  "recovery-code-used",
  "recovery-codes-regenerated",
  "passkey-added",
  "passkey-removed",
  "passkey-cloned",
] as const
export type AccountSecurityEvent = (typeof ACCOUNT_SECURITY_EVENTS)[number]

export type AccountSecurityParams = { event: AccountSecurityEvent; remaining: number }

const HEADLINE: Record<AccountSecurityEvent, string> = {
  "factor-enabled": "Two-factor authentication is on for your Patchgrid account",
  "factor-disabled": "Two-factor authentication was turned off for your Patchgrid account",
  "factor-locked": "Your Patchgrid second factor is locked for an hour",
  "recovery-code-used": "A recovery code was used to sign in to your Patchgrid account",
  "recovery-codes-regenerated": "Your Patchgrid recovery codes were replaced",
  "passkey-added": "A passkey was added to your Patchgrid account",
  "passkey-removed": "A passkey was removed from your Patchgrid account",
  "passkey-cloned": "One of your Patchgrid passkeys may have been copied",
}

export function accountSecuritySubject(p: AccountSecurityParams): string {
  return HEADLINE[p.event]
}

/**
 * To the person, whenever their second factor changes or comes under attack
 * (ADR-0029, ADR-0045, ADR-0053). Every line ends the same way: if it was not you, the
 * password is known to someone else.
 */
export function AccountSecurity(p: AccountSecurityParams) {
  return (
    <MailLayout preview={HEADLINE[p.event]}>
      <p>
        <strong>{HEADLINE[p.event]}.</strong>
      </p>
      {p.event === "factor-enabled" && (
        <p>
          From now on, signing in with your password also takes a code from your authenticator app.
          {p.remaining > 0 && <> You were shown {p.remaining} recovery codes; keep them somewhere safe.</>}
        </p>
      )}
      {p.event === "factor-disabled" && (
        <p>Signing in no longer asks for a code from your authenticator app. If it was your only second factor, workspaces that require one will ask you to set one up before they open.</p>
      )}
      {p.event === "factor-locked" && <p>Five wrong codes were entered after your password. If that was not you, someone has your password: change it now.</p>}
      {p.event === "recovery-code-used" && (
        <p>
          {p.remaining} recovery code{p.remaining === 1 ? "" : "s"} left. Every other session you had was signed out. If this was not you, someone has your password and a
          recovery code: change the password, then turn two-factor authentication off and on again to get new codes.
        </p>
      )}
      {p.event === "recovery-codes-regenerated" && <p>The old codes no longer work. {p.remaining} new ones were shown to you once.</p>}
      {p.event === "passkey-added" && (
        <p>
          It signs you in on its own, without your password.
          {p.remaining > 0 && <> You were shown {p.remaining} recovery codes; keep them somewhere safe.</>}
        </p>
      )}
      {p.event === "passkey-removed" && <p>It no longer signs you in. Your other factors are unchanged.</p>}
      {p.event === "passkey-cloned" && (
        <p>
          A sign-in with one of your passkeys was refused because its counter went backwards, which happens when a security key has been copied. Remove that passkey from your
          account and add it again.
        </p>
      )}
      <p>If this was not you, change your password straight away.</p>
    </MailLayout>
  )
}
