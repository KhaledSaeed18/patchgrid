# 0035 — The browser owns the refresh; the Next server never sees a refresh token

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** [0007](0007-web-calls-api-directly-no-bff.md) (`apiFetch`'s refresh-and-retry) and [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md) (cookie paths)

## Context

ADR-0007 gives `apiFetch` "one refresh-and-retry on 401", on the server as well as in the browser.
ADR-0024 scopes the refresh cookie `pg_rt_<slug>` to `Path=/api/v1/auth`. Those two cannot both hold:
a browser sends a cookie only to requests whose path matches, so a page request to
`acme.patchgrid.xyz/tickets` never carries `pg_rt_acme`, the Next server never holds it, and a server
component that meets a 401 has nothing to refresh with. The handoff listed this as the question to
settle before `apiFetch`.

Access tokens live fifteen minutes and are also cut short by the revocation epoch (role change, team
change, disable), so a 401 on a server render is ordinary, not exceptional.

## Options considered

1. **Widen the refresh cookie to `Path=/`.** The Next server then receives it on every page request and
   can refresh server-side. Every page request now carries the most powerful tenant credential, the Next
   process handles refresh tokens it would otherwise never see, and a rotation done server-side must set
   the new pair on the page response — racing every parallel request the browser makes with the old one,
   which reuse detection treats as theft.
2. **A Next route handler at `/api/v1/auth/refresh`** on each tenant host, so the path-scoped cookie
   reaches the Next server after all. A second backend endpoint in disguise, which ADR-0007 forbids.
3. **The browser refreshes; the server never does.** `proxy.ts` reads the access cookie's expiry
   (unverified — it is only deciding where to send the browser, never granting anything) and, when it is
   missing or about to lapse, sends the request through a small client-rendered page that calls
   `POST /auth/refresh` directly and then returns to where the user was going. A server component that
   still meets a 401 — a token revoked mid-flight — redirects to the same page.

## Decision

Option 3.

- **The refresh cookie stays path-scoped to the API's auth routes.** The Next server never receives a
  refresh token or `pg_id` secrets beyond forwarding them; it forwards the access cookie and `pg_id`
  only.
- **`proxy.ts` on a tenant host**: no access cookie and no `pg_id` → the login page on `app.`, with the
  original URL to return to. Access cookie absent or expiring within 60 seconds, `pg_id` present →
  `/session/refresh?next=…` on the same host. Otherwise, through.
- **`/session/refresh`** is a client component: one `POST /auth/refresh` with credentials; on success,
  `location.replace(next)`; on failure, the login page. `next` is accepted only as a same-origin path.
- **Server-side `apiFetch`** forwards `pg_at_<slug>` and `X-Patchgrid-Tenant`, and on a 401 throws a
  `redirect` to `/session/refresh?next=…` for the page being rendered. It never retries.
- **Client-side `apiFetch`** sends credentials directly to the API, and on a 401 calls
  `POST /auth/refresh` once and retries once; a second 401 sends the browser to the login page.
  Concurrent 401s share one refresh, so a burst of queries does not rotate the token several times —
  which reuse detection would read as theft.
- **Mutations are browser → API.** Server functions stay thin form glue and are not used for mutations
  that need a session, so no server-side code path ever needs a fresh token mid-request.

## Consequences

- One redirect hop roughly every fifteen minutes of navigation, and after a revocation. Invisible in
  practice; the refresh page renders nothing but a spinner.
- The Next server's blast radius shrinks: compromising it yields fifteen-minute access tokens, never a
  seven-day refresh token.
- `proxy.ts` decodes a JWT without verifying it. That is safe only because it uses the result to choose
  a redirect, never to authorize; the API verifies every token it is handed. The code says so where it
  does it.
- If a future surface genuinely needs server-side refresh (a long-running server job acting as a user),
  it needs its own credential, not this cookie.
