# 0007 — Next.js calls the NestJS API directly; no BFF layer

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

With Next.js App Router it is tempting to put data access in server actions and route handlers, effectively making a second backend. The project rule is that NestJS owns all business logic and DB access. We still need to decide how the web app talks to the API and whether it wraps it.

## Options considered

1. **Next.js route handlers as a BFF proxy** (`/app/api/*` → Nest) — one origin for the browser; but every endpoint is declared twice, and it invites "just a little logic" in the proxy.
2. **Server actions that call Nest** for mutations, server components that call Nest for reads — keeps the browser talking only to Next; still a thin wrapper per mutation.
3. **Browser and server components both call Nest directly** through one typed client (`apiFetch`), with cookies shared across subdomains of one registrable domain (`.lvh.me` in dev, `.patchgrid.xyz` in prod — ADR-0014). Server actions are allowed only as thin form-handling glue that calls `apiFetch`.

## Decision

Option 3. `apps/app/lib/api/` is the only place that knows the API base URL, forwards cookies on the server, attaches `X-Requested-With`, parses responses with `@patchgrid/contracts`, performs the one-shot refresh-and-retry on 401, and converts Problem Details to a typed `ApiError`. TanStack Query hooks wrap it on the client. No `app/api/*` route handlers except `/api/health` for the container itself. `apps/www` follows the same rule and is limited to the three public endpoints in ADR-0016.

## Consequences

- Cookies are scoped to `Domain=.patchgrid.xyz`, and CORS validates the origin against the tenant slug regex with credentials enabled (ADR-0014). Because subdomains are same-site, CSRF protection also requires the `X-Requested-With` header and an `Origin` check.
- Contract schemas are exercised on both ends, so drift shows up in tests, not in production.
- No hidden second backend — the "why not" is visible in code review.
- SSE and presigned uploads also go browser → service directly, consistently with this rule.
