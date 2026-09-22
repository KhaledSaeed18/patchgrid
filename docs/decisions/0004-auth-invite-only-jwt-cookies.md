# 0004 — Invite-only users, JWT access + rotating refresh tokens in httpOnly cookies

- **Status:** Accepted — invite-only onboarding superseded by [0017](0017-org-signup-and-provisioning.md); session mechanism stands
- **Date:** 2026-09-22

## Context

Patchgrid is an internal tool: every user belongs to the organization and is known to IT. Next.js server components need to call the API on the user's behalf, which rules out tokens that live only in browser JS memory. The original spec said "JWT-based sessions" and also listed Redis for "session/cache", which is contradictory.

## Options considered

**Onboarding**
1. Public self-signup with email verification — unnecessary for an internal desk and creates an abuse surface.
2. **Admin invitation by email** — matches the domain, gives the admin UI a real feature, exercises the mail pipeline early.

**Session mechanism**
1. Stateful server sessions in Redis — simple revocation; but every API call hits Redis and it makes the API stateful for no strong reason.
2. Long-lived JWT in `localStorage` — XSS-exfiltratable, not readable by server components.
3. **Short-lived JWT access token (15 min) + rotating opaque refresh token (7 days), both in httpOnly cookies; refresh tokens hashed in Postgres with reuse detection** — stateless hot path, revocable, works for server-side fetches, standard pattern.
4. A hosted auth provider — fewer learning outcomes, external dependency for a self-hosted tool.

**Password hashing**: Argon2id (`argon2` package) over bcrypt — current OWASP recommendation.

## Decision

Invite-only onboarding, option 3 for sessions, Argon2id. `RefreshToken` rows form a chain (`replacedById`); presenting an already-rotated token revokes the whole chain (token theft signal). Password reset via emailed single-use token. Redis is used for queues and throttling only, not sessions.

Cookies: `httpOnly`, `SameSite=Lax`, `Secure` outside development, `Path=/api` for the refresh cookie. Mutating requests must also carry an `X-Requested-With` header, which cross-site forms cannot set — belt and braces against CSRF.

## Consequences

- Server components forward cookies to the API; `apiFetch` handles 401 → refresh → retry once.
- Logout = revoke refresh chain + clear cookies; the access token stays valid for ≤ 15 min, which is acceptable for this tool.
- Admin deactivating a user revokes all their refresh tokens immediately.
- OAuth/SSO is a possible later ADR; nothing here prevents adding an external identity provider that mints the same cookies.
