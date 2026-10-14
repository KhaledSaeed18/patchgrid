# 0040 — The platform credential, and MFA for platform admins ahead of M9

- **Status:** Accepted
- **Date:** 2026-10-15
- **Resolves:** THREAT-MODEL **TM-2**; corrects `RBAC.md` §2 ("resolved from the host")
- **Brings forward:** the platform-admin half of [0029](0029-mfa-and-step-up-authentication.md)

## Context

`RBAC.md` §2 said the platform actor is "resolved from the host": `admin.patchgrid.xyz` produces a
platform actor, and a tenant subdomain produces a member actor. ADR-0024 corrected exactly this for
tenants. The API is `api.patchgrid.xyz` and never sees `admin.` in its `Host`. A host is where a request
was sent, not who sent it. A platform actor must come from a credential, the same as a member does.

ADR-0029 makes MFA mandatory for platform admins. TM-2's proposed fix mints the platform credential only
after MFA. MFA itself is an M9 item, but M8 builds the back-office that needs it. A back-office that
ships without its second factor and gets one later would be the weak period ADR-0029 exists to prevent.

## Decision

**The platform credential is its own token, minted by its own login, only after a second factor.**

- **Login is a separate flow** under `/api/v1/platform/auth`. A tenant login never produces it, and it
  never produces a tenant session.
  1. `POST /login` takes an email and password. A wrong password and "not a platform admin" are the
     same `401`, so the endpoint does not reveal who is an admin. Success sets a five-minute challenge
     cookie, which says whether the next step is to verify a factor or to enrol one.
  2. With no confirmed factor, `POST /mfa/enrol` returns a TOTP secret and its `otpauth://` URI, stored
     encrypted and unconfirmed. `POST /mfa/confirm` with a valid code confirms it, returns ten recovery
     codes **once**, and signs in.
  3. With a factor, `POST /mfa` takes a code or one unused recovery code, and signs in.
- **The session** is a JWT with audience `platform`, carrying the platform admin's id and user id:
  - It lives in an HttpOnly cookie `pg_pa`, **path-scoped to `/api/v1/platform`**. A tenant route never
    receives it, whichever page the browser is on.
  - It lasts one hour, with no refresh. An operator signs in again, factor included.
  - It is checked against a revocation epoch keyed `platform:<id>`. Signing out, or losing the
    `PlatformAdmin` row, ends every session at once.
- **Platform routes are marked `@PlatformRoute`.** Tenant resolution skips them. The auth guard accepts
  only `pg_pa` on them, and only with `Origin` (or, from a server, `X-Patchgrid-Surface`) naming the
  `admin.` host. It is a cross-check, as a tenant `Origin` is.
  - A tenant credential on a platform route is ignored. The route sees no `pg_pa`, which is a `401`.
  - A platform credential cannot reach a tenant route: its path keeps it from being sent, and the
    `admin.` origin resolves to no tenant.
  - The route-coverage test counts `@PlatformRoute` as an answer, like `@Public`.
- **The `platform` actor holds no tenant permission.** `permissionsFor` returns nothing for it, and
  platform services assert the actor kind. Tenant content stays reachable only through a support
  session (ADR-0020), which is a later M8 item. That reaches content through `runAsTenant`, never
  through this credential alone.
- **MFA for platform admins arrives now, as ADR-0029 specified it**:
  - `UserMfaFactor` (TOTP, secret AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY`) and
    `UserMfaRecovery` (ten Argon2id-hashed single-use codes), both platform-class;
  - confirm-before-activate, and an unconfirmed factor expires in an hour;
  - a code is good for its 30-second step and one step either side, and the last step used is stored,
    so a code is never accepted twice.

  Per-org `requireMfa`, member enrolment and step-up re-authentication stay in M9. They build on these
  tables unchanged.
- **Granting is by CLI only**: `pnpm platform:grant <email>` and `pnpm platform:revoke <email>` run against
  the database, for an existing verified user. There is no route that makes a platform admin.
- **Platform actions are audited twice where both apply:**
  - into `PlatformAuditLog` (platform-class): grants, revocations, sign-ins, factor enrolment;
  - into the **tenant's own** log as actor kind `PLATFORM`, for what an operator does to a tenant —
    suspend, unsuspend, set plan, restore (`RBAC.md` §8).
- **`admin.` is served by `apps/app`**, as `app.` is. The host router gives it its own route group, which
  keeps three deployables. `admin` is already a reserved slug and an infrastructure origin.

## Consequences

- Operators sign in more often than members do. That is the price of a credential that can suspend
  every customer.
- A stolen password alone signs nobody in. A stolen `pg_pa` is good for at most an hour and dies with a
  sign-out.
- M9's MFA item becomes "extend to members": the enrolment and verification code already exists.
- Production needs `MFA_ENCRYPTION_KEY` kept apart from the database. A dump without it yields no
  second factors.
