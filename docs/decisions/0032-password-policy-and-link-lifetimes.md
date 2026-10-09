# 0032 — Password policy and one-time link lifetimes

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** [0004](0004-auth-invite-only-jwt-cookies.md) (password reset) and [0031](0031-identity-flow-hardening.md) (uniform identity endpoints)

## Context

The M1 auth item shipped two rules that no document had decided: what a password must look like, and
how long a password-reset link stays usable. Both were chosen in code (`contracts/auth.ts`,
`identity.service.ts`) and flagged in the handoff as needing confirmation. The verification-link
lifetime was already fixed at twenty-four hours by `TENANCY.md` §4; the reset link had no number.

Constraints that matter:

- **Online guessing is throttled, offline guessing is Argon2id.** Login is rate-limited per address and
  per email hash (ADR-0031), and a stolen hash costs Argon2id per guess. The policy only has to make the
  remaining search space large; it does not have to stand alone.
- **Argon2id's cost scales with input length.** An unbounded password is a cheap way to make the server
  do expensive work on an anonymous endpoint.
- **The policy itself must not become an oracle** on the login path, where ADR-0031 already requires one
  answer for every failure.
- **A reset link is a bearer credential for the account** that sits in an inbox, in mail-client
  previews and possibly in forwarded mail. A verification link only proves an address; a reset link
  replaces the password.

## Options considered

### Password policy

1. **Composition rules** (upper, lower, digit, symbol). Familiar. NIST 800-63B advises against them:
   they push users towards predictable patterns (`Password1!`) and add friction without adding entropy.
2. **Length only, 8 minimum** — NIST's floor for user-chosen secrets. Weak for an admin console that
   holds other companies' incident data.
3. **Length only, 12–128** — a minimum that makes passphrases the easy path, a maximum that bounds the
   hashing cost. No composition rules.
4. **Option 3 plus breached-password screening** (k-anonymity range queries against a breach corpus).
   The best answer, but an external dependency on the signup and reset paths.

### Reset-link lifetime

1. **Twenty-four hours**, matching verification. Simple; a day-long window for a credential that takes
   over the account.
2. **Fifteen minutes.** Tight; mail delivery delays and a user switching devices make it fail in
   ordinary use, and a failed reset is a support ticket.
3. **Thirty minutes**, single use, and issuing a new one voids those outstanding. Long enough for slow
   mail, short enough that a leaked link is usually dead before it is found.

## Decision

**Passwords are length-only, 12 to 128 characters**, with no composition rules. The bounds live once, as
`PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` in `@patchgrid/contracts`, and every _setting_ path —
signup, reset confirmation, change — validates with `passwordSchema`. **Login does not**: it accepts
any non-empty string up to the maximum, so "too short" never distinguishes itself from "wrong".
Breached-password screening (option 4) is deferred, not rejected; it adds a check after the length
rule when it lands.

**Reset links live thirty minutes; verification links twenty-four hours.** Both are single-use 256-bit
secrets stored as SHA-256, and issuing either voids the outstanding ones of the same kind. Following a
reset link also marks the address verified, for the reason ADR-0031 gives for invitations: a link
delivered to the inbox proves control of it. A completed reset ends every session.

## Consequences

- The signup and reset forms in `apps/app` / `apps/www` render the limits from the contracts constants,
  never a restated number.
- A user with a 10-character password from another system cannot reuse it here. Accepted.
- Changing either bound later only affects new passwords; existing hashes stay valid. Raising the
  minimum does not force a reset, and the policy does not pretend otherwise.
- Breached-password screening, when added, needs its own decision on the provider and on failing open
  versus closed when that provider is down.
- A user who opens a reset mail after thirty minutes requests another; the uniform response
  (ADR-0031) means the request endpoint never says whether the first one was used.
