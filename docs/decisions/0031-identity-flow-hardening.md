# 0031 — Identity-flow hardening: invite binding, uniform responses, a revocable `pg_id`

- **Status:** Accepted
- **Date:** 2026-09-23
- **Supersedes in part:** [0017](0017-org-signup-and-provisioning.md) — the immediate session at signup
- **Refines:** [0017](0017-org-signup-and-provisioning.md) (invitations) and [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md) (`pg_id`)

## Context

Drawing the trust boundaries in `THREAT-MODEL.md` produced three findings in the anonymous and
tenant-less identity flows. All three sit on the path M1 builds first, so each needs a decision before
the auth work starts.

**TM-3: an invitation is bound to a link, not a person.** An invitation carries a role and an email
address, and its token is `<orgId>.<secret>`, hashed and single-use (ADR-0022). But nothing requires the
account that accepts it to _be_ the invited address. An `ADMIN` invite forwarded to a colleague, pasted
into a ticket or leaked through a mail-client link preview admits whoever clicks first. That includes
an already-logged-in user with a completely different account.

**TM-4: the identity endpoints are an account-enumeration oracle.** `TENANCY.md` §4 specified signup as
"account creation … or login if the email exists", which tells an anonymous caller whether an address
has an account. Login and password reset were unspecified, which in practice means they leak the same
fact. For an ITSM product, knowing which addresses have accounts means knowing whose IT desk runs here,
and that is the reconnaissance step before phishing them.

**TM-5: `pg_id` is the most powerful cookie, and nothing specified it.** ADR-0024 introduced `pg_id` as
the tenant-less identity used by `app.patchgrid.xyz` to list workspaces and mint tenant cookie pairs. It
can therefore mint a session for _every_ workspace a user belongs to. Its format, lifetime, storage,
rotation and revocation were never written down. The revocation epoch is per `membershipId`, so it does
not cover a credential that sits above memberships.

## Options considered

**Invitations**

1. **The link is sufficient.** Simplest, and the common implementation. The role in the invitation is
   granted to whoever holds the link.
2. **Bind to the invited email.** Acceptance requires the accepting account's email to equal
   `Invitation.email`. Costs one comparison. An admin who typed the wrong address re-invites.

**Enumeration**

1. **Accept it as a residual risk.** The friendlier UX: signup tells you that you already have an
   account.
2. **Uniform responses.** Every anonymous identity endpoint answers identically whether or not the
   address exists. Anything that differs goes to the inbox, which only the owner can read.

**`pg_id`**

1. **A signed JWT** with a per-user epoch in Redis. Stateless and cheap. Revocation depends on Redis, and
   during an outage ADR-0024 fails open for reads, which here would mean minting sessions.
2. **An opaque, rotating token backed by a `RefreshToken` row** with `orgId` null. That column was
   already nullable, and the table already has rotation, reuse detection and revocation.

## Decision

Option 2 in all three cases.

### Invitations are bound to the invited address

- Acceptance succeeds only when the accepting account's email equals `Invitation.email` (both are
  already normalised to lower case). A mismatch returns the **same generic failure** as a bad or expired
  token, so it reveals nothing about the invitation.
- A new account created **through** the invitation link is marked `emailVerifiedAt = now()`: following a
  link delivered to that inbox is proof of control, which is exactly what verification establishes.
- A logged-in user whose email differs is shown "this invitation was sent to a different address" only
  **after** the token itself has verified, because at that point they have proved they hold the link.
  They are not shown the invited address.

### Anonymous identity endpoints answer uniformly

| Endpoint                         | Response, whether or not the account exists | What differs, and where it goes                                                     |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /auth/signup`              | `202 Accepted`                              | Email: "verify your address" **or** "you already have an account — log in or reset" |
| `POST /auth/login`               | `401`, "invalid email or password"          | Nothing                                                                             |
| `POST /auth/password-reset`      | `202 Accepted`                              | Email sent only if the account exists                                               |
| `POST /auth/resend-verification` | `202 Accepted`                              | Email sent only if the account exists and is unverified                             |

- **Timing is part of the response.** Login against an unknown address still runs one Argon2id
  verification, against a fixed dummy hash, so response time does not reveal the answer. Signup does
  the same amount of work on both paths and enqueues mail rather than sending inline.
- All four are throttled per IP **and** per truncated SHA-256 of the email, before any lookup.
- **Signup therefore cannot start a session.** A session for a new address and none for an existing
  one would be the oracle again. The emailed verification link completes signup and starts the session.
  This **supersedes** ADR-0017's "provision immediately, restrict until verified" for the signup step:
  a new user now reaches workspace creation one inbox round trip later. A consequence: no session ever
  belongs to an unverified address. ADR-0017's restrictions on unverified users (no outbound mail, no
  invites, one organization) become unreachable rather than wrong, and stay as defence in depth.
- **Out of scope:** `GET /orgs/slug-available` necessarily answers, and slug existence stays accepted risk
  R-2. Slugs are public. Whether a person has an account is not.

### `pg_id` is a refresh token without an org

- `pg_id` is an **opaque, rotating** token stored as a hash in `RefreshToken` with `orgId = NULL`.
  Rotation and reuse detection come from ADR-0004 unchanged: presenting a rotated `pg_id` revokes the
  whole chain.
- Lifetime **7 days**, the same as tenant refresh tokens. Cookie attributes are unchanged from
  ADR-0024.
- **Minting a tenant pair re-reads `Membership` inside `runAsTenant(orgId)`** — never `UserOrgIndex` —
  and checks `rev:<membershipId>`. A stale projection can list a workspace; it cannot open one.
- Revoked by: password change, password reset, "log out everywhere", and user anonymisation (ADR-0028).
  Logging out of one workspace does not revoke it.

## Consequences

- Every rule has a test in the M1 auth integration suite: a mismatched-email acceptance fails
  generically; each identity endpoint produces an identical status and body for a known and an unknown
  address; a revoked `pg_id` cannot mint a pair; a disabled membership cannot be entered through the
  picker even when `UserOrgIndex` is stale.
- ADR-0024's cookie table is unchanged; this ADR specifies what stands behind `pg_id`, which it left
  open. `TENANCY.md` §6 carries the rule.
- **Signup is one inbox round trip longer** before a session exists. This is a real UX cost, and it
  reverses a deliberate choice in ADR-0017. It is the price of not telling strangers whether a person
  uses Patchgrid.
- An admin who invites the wrong address has to revoke and re-invite. That is the correct cost:
  "whoever has the link" is not a person.
- Reversing any of these is cheap in code and should need a new ADR, because each one removes a property
  the threat model depends on.
