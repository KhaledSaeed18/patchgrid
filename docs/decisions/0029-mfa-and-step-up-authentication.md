# 0029 — MFA (TOTP) and step-up authentication

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0004](0004-auth-invite-only-jwt-cookies.md)

## Context

The original specification had no second factor anywhere — not for owners, not for admins, not even for
`PlatformAdmin`, the identity that can suspend every customer. It was not listed as a non-goal either,
which is the one option that costs something: a reviewer reading a product whose central claim is
"access control designed around the customer's trust" (ADR-0020) will ask, and silence reads as
oversight rather than as a decision.

It is also disproportionately cheap. TOTP is a shared secret, a 6-digit code and a 30-second window;
`otpauth` does the arithmetic. What makes it worth building is not the crypto but the surrounding
problems — enrolment, recovery, "remember this device", and deciding which actions deserve a second
prompt — which are exactly the parts most implementations get wrong.

## Options considered

1. **No MFA, stated as a non-goal.** Honest and free. Leaves the strongest security claim in the product
   resting on a password.
2. **TOTP.** Offline, no SMS cost, no phone-number PII, universally supported by authenticator apps.
   Vulnerable to real-time phishing — a proxied login page relays the code.
3. **WebAuthn / passkeys.** Phishing-resistant, the genuinely correct answer, and a materially larger
   build: attestation, multiple authenticators per user, cross-device sync caveats, and a recovery story
   that is harder than TOTP's.
4. **A hosted identity provider.** Removes the learning, adds a dependency to a self-hostable tool.

## Decision

TOTP now (option 2), with the data model shaped so that WebAuthn is an additional row type rather than a
rewrite.

```
P  UserMfaFactor  { id, userId, kind: TOTP, secretEncrypted, confirmedAt?, lastUsedAt?, label }
P  UserMfaRecovery{ id, userId, codeHash, usedAt? }        -- 10 single-use codes, Argon2id
```

`kind` is an enum with one value today. WebAuthn becomes `kind: WEBAUTHN` with a different payload column
and the same enrolment, challenge and recovery flows.

- **Enrolment** is confirm-before-activate: the secret is stored unconfirmed, the user proves one code,
  and only then does `confirmedAt` set and the recovery codes appear — once. A factor that is never
  confirmed expires in an hour. This is what prevents locking someone out of their own account with a
  mis-scanned QR code.
- **Secrets are encrypted at rest** with a key from the environment, not merely hashed — TOTP requires
  the plaintext to verify. The key is separate from the database, so a database dump alone does not
  yield second factors.
- **Mandatory for `PlatformAdmin`.** No platform action is permitted without a confirmed factor; the CLI
  that grants platform admin also prints the enrolment requirement.
- **Optional per user, enforceable per org**: `Organization.requireMfa` (an `OWNER` setting, audited).
  When on, members without a confirmed factor are routed to enrolment and can do nothing else. Enabling
  it does not lock out existing sessions — it gates the next authentication, which is the difference
  between a policy and an outage.
- **Step-up re-authentication** for actions whose damage is irreversible, regardless of whether MFA is
  otherwise required: `org:delete`, `org:transfer_ownership`, `support:grant_access`, `token:create`,
  `org:manage_plan`, and disabling MFA itself. A step-up is a fresh factor (or password, if no factor is
  enrolled) within the last 5 minutes, carried as a claim and checked in the service — **not** in a
  guard, because it is an authorization condition and belongs where the other ones live.
- **Recovery codes** are the only bypass: 10 single-use Argon2id-hashed codes, regenerable, and using one
  emails every one of the user's owners-of-record and bumps the revocation epoch on all their memberships
  (`TENANCY.md` §6). There is no support-mediated MFA reset — a support path that disables a second factor
  *is* the second factor, and ADR-0020 already forbids operators from acting as users.
- **Rate limits** are per user, not per IP: 5 failed codes in 15 minutes locks the factor for an hour and
  notifies the user. Used codes are cached so a replayed code inside its window fails.
- **"Remember this device"** is explicitly **not** built in v1. It needs a device-binding token with its
  own revocation story, and it is the feature most often used to quietly undo MFA.

## Consequences

- The product can state, accurately, that the account able to suspend every tenant cannot be taken over
  with a password alone.
- Login gains a second step and a partially-authenticated state, which touches the token flow: a
  password-only session mints an `mfa_pending` token good for nothing but completing MFA.
- Step-up is where this earns its place for the portfolio — it is the part that demonstrates thinking
  about *which* actions deserve friction, rather than bolting a checkbox onto login.
- Passkeys become the obvious next ADR, and this design does not obstruct it.
- Scheduled for M9, after the platform layer exists, because `PlatformAdmin` is the identity that most
  needs it and it does not exist until M8.
