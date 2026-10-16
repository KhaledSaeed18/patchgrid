# 0045 — Member MFA as built: a challenge before the session, a proof on the token

- **Status:** Accepted
- **Date:** 2026-10-16
- **Refines:** [0029](0029-mfa-and-step-up-authentication.md); builds on [0040](0040-platform-credential-and-the-admin-host.md)

> **Erratum (2026-10-16).** "Self-service … all on `pg_id`" was one route too many: `pg_id` is a
> long-lived bearer, and whoever held one could enrol an authenticator of their own and lock the
> person out of every workspace that requires a factor. `POST /auth/mfa/enrol` now takes the
> password, counted against the same lockout as a wrong code. Confirming, replacing the codes and
> turning the factor off are proved by the factor, as the body says. (M9 security review, finding 3.)

## Context

ADR-0029 decided TOTP for everyone, optional per person and enforceable per workspace, with step-up
re-authentication before the actions whose damage is irreversible. ADR-0040 built the half of it the
back-office needed in M8: the tables, the encrypted secret, confirm-before-activate, recovery codes, the
per-person lockout, and a code that is never accepted twice. M9 extends it to members. The mechanics are
the operator's; what this record settles is the shape of the member flows, because a member's session
is built differently from an operator's — a `pg_id` that outlives any workspace, and a per-workspace
cookie pair that the browser refreshes on its own (ADR-0024, ADR-0035).

## Decision

### Login stops at the password

`POST /auth/login` with the right password and a confirmed factor answers `{ status: "mfa-required" }`
and sets `pg_mc`: a five-minute HS256 challenge naming the person and the workspace the login asked for,
path-scoped to `/api/v1/auth` like the refresh cookie, with its own audience so neither an access token
nor the platform's challenge can stand in for it. Nothing else is set — no `pg_id`, no pair — and the
identity routes answer `401` until `POST /auth/mfa` presents a code or a recovery code. A wrong
password is the same `401` as before, factor or not: the challenge is the first thing that admits the
password was right, and it only ever reaches the person who typed it.

The emailed verification link and a new account accepting an invitation keep starting a session
directly: no factor can exist before an address is verified, so there is nothing to ask for.

### The policy gates the next authentication

`Organization.requireMfa` is an owner's setting (`org:require_mfa`, a new row in the matrix), audited as
`ORG_MFA_REQUIREMENT_CHANGED`, and read from the cached organization summary — so turning it on
invalidates the summary like a visibility change does. It is checked in exactly three places, all in
`SessionService`: opening a workspace from the picker, minting the pair at login, and refreshing. A
member without a confirmed factor gets `403 mfa-required` from the first two and the third; the refresh
token itself is not revoked, so enrolling makes it good again. A session already open is never ended
by the policy. That is the line ADR-0029 drew between a policy and an outage, and it is what the
settings page says in plain words.

### Step-up is a claim on the access token

`POST /auth/step-up` is tenant-less, as every auth route is: a `pg_id` holder names the workspace, as
`POST /auth/sessions` does, and proves themselves. The API re-reads the membership inside the tenant and
re-issues that workspace's pair with `sua` — step-up at, unix seconds — on the access token. The
services for `org:delete`, `support:grant_access`, `token:create` and the transfer of ownership assert
`StepUpService.assert(actor)` after the permission and before any write: a member whose `sua` is within
the last five minutes passes; everyone else gets `403 step-up-required`, a problem type of its own so
the client can tell it from a plain refusal and open the dialog. A refresh re-mints without the claim:
the proof belongs to the step-up, not to the session, and five minutes is the whole of its life.

Ownership has no route of its own. RBAC.md §2 defines the transfer as "promote, then the outgoing owner
steps down", so raising anyone to `OWNER` is where `org:transfer_ownership` and the step-up are
asserted, alongside `member:promote_admin`. `org:manage_plan` is in ADR-0029's list but has no tenant
route yet; it gets the assertion when it gets the route.

**The proof is the factor when one is enrolled, and only then the password.** A password can never
stand in for a factor that exists, or the factor guards nothing against a stolen password. Someone with
no factor proves the password, counted against the same per-person lockout as a wrong code would be.

A service account cannot step up — there is no person to re-prove — and none of the four actions is
reachable by any scope (RBAC.md §10). A support session is read-only before this question arises.

### Self-service is proved by the factor, never by the password

Enrol, confirm, replace the recovery codes, turn off — all under `/auth/mfa`, all on `pg_id`, so they
belong to the person and not to any workspace. Turning the factor off takes a current code or a
recovery code; replacing the codes takes a current code. ADR-0029 listed disabling MFA among the
step-up actions, and this is that step-up in the only form the identity routes can carry it: the proof
in the request, since there is no access token to stamp. Every change is confirmed by mail, with the
same closing line each time — if this was not you, someone has your password.

### A recovery code ends every other session

Using one revokes every refresh token and bumps every membership epoch, as ADR-0029 said; it spares the
very second it runs in, so the session the code is about to earn survives its own revocation. The
person is told by mail, with how many codes remain. At login that is the whole story. In the step-up
and turn-off flows it means the person is signed out everywhere a moment later — which is right: a
recovery code in use means the factor is lost or taken, and the dialog says so.

## Consequences

- A member's password alone opens nothing once a factor is confirmed, and a workspace can insist on it
  for everyone without signing anyone out.
- The four irreversible actions cost one more prompt, at most once per five minutes, and never more
  than that: the dialog retries exactly what was being done.
- A plain `pg_at_<slug>` cookie stolen from a browser cannot mint a token, delete the workspace, let an
  operator in, or make an owner. It still reads tickets, as it did.
- The integration specs that mint, grant, delete and promote now re-prove themselves first through one
  seed helper, and each shows the plain session refused.
- "Remember this device" stays out, as ADR-0029 decided. Passkeys remain the obvious next factor kind;
  this record adds nothing that would obstruct them.
