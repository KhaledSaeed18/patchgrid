# 0024 — Per-tenant session cookies, API tenant resolution, and revocation

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0014](0014-subdomain-per-tenant-routing.md) (cookies, CORS, CSRF) and [0004](0004-auth-invite-only-jwt-cookies.md) (session mechanism)

## Context

Three defects in the session design surfaced while tracing a request end to end.

**1. The API cannot resolve a tenant from its own `Host`.** `ARCHITECTURE.md` specified
"host → slug → Organization" and `TENANCY.md` specified "compares the host's organization against the
token's `org`". Every API request arrives at `api.patchgrid.xyz`; there is no slug in that host and no
`acme.api.patchgrid.xyz`. Meanwhile ADR-0014 said the tenant comes from `Origin`/`Referer` — but under
ADR-0007, Next.js **server** components call the API directly, and a server-to-server `fetch` sends no
`Origin` at all. That is not an edge case; it is most page loads.

**2. One shared cookie reproduces the drawback subdomains were chosen to avoid.** ADR-0014 justified
subdomain-per-tenant partly because "two tenants can be open in two tabs", and criticised the
single-host option because "multiple sessions in one browser fight over one cookie". It then issued the
session cookie on `Domain=.patchgrid.xyz` — one cookie for every tenant. The failure is deterministic
and will be hit by the project's own seeded `both@acme.test` account:

1. Tab A on `acme.patchgrid.xyz` holds an acme-bound token.
2. Tab B opens `globex.patchgrid.xyz` → token org ≠ requested org → `403` → org picker → a globex token
   is minted **into the same cookie**.
3. Tab A's next request presents a globex token for acme → `403` → org picker → mints an acme token →
   tab B breaks. Repeat forever.

**3. "Instant" revocation is not instant.** Access tokens are stateless and live 15 minutes. Revoking
refresh tokens does nothing to a token already in a browser, so a disabled member keeps full access for
up to 15 minutes, a revoked API token keeps working, and `RBAC.md`'s promise that an owner can revoke a
support session "instantly" is unbacked. Fifteen minutes is a long time for someone who was just
offboarded — which is a literal ITSM use case.

## Options considered

**Tenant resolution on the API**
1. Parse a slug from `Host` — impossible, there is none.
2. Resolve from `Origin` only — breaks every server component; SSE and API tokens have no usable Origin
   either.
3. **The token is the tenant; `Origin` is a cross-check** — the binding already lives in the credential,
   which is the only thing every caller presents.

**Cookies**
1. One cookie on `.patchgrid.xyz` — the current, broken state.
2. **Per-tenant cookie names on `.patchgrid.xyz`** — `api.` can still read them, each tenant has its own
   slot.
3. Host-only cookies per subdomain plus an `Authorization` header to the API — strongest separation, but
   `api.patchgrid.xyz` could no longer read them, which breaks direct browser→API calls (ADR-0007) and
   kills `EventSource`, which cannot set headers.
4. Put `patchgrid.xyz` on the Public Suffix List — would give every tenant its own cookie jar and end
   cookie tossing outright, but makes `Domain=.patchgrid.xyz` cookies impossible, so `app.` and `api.`
   could no longer share a session at all. A genuinely interesting option; deferred to the DNS ADR.

**Revocation**
1. Shorten the access token to ~1 minute — pushes refresh traffic up ~15× for a partial fix.
2. Look up the session in the database per request — makes the hot path stateful, which ADR-0004
   explicitly avoided.
3. **A revocation epoch in Redis**, one `GET` on a path that already touches Redis for throttling.

## Decision

### 1. Tenant resolution order on `apps/api`

The tenant is resolved once, in this order, and the result is what everything downstream uses:

1. `Authorization: Bearer pg_…` present → the tenant is the token's org (ADR-0021, resolved via
   `ApiTokenIndex`, ADR-0022). Cookies are ignored entirely.
2. Otherwise the **access-token cookie's `orgId` is the tenant.** This is authoritative.
3. If `Origin` is present it **must** resolve to that same org, else `403`. This is the CSRF and
   cookie-tossing check — not the resolution mechanism.
4. If `Origin` is absent (server-side `apiFetch`), `X-Patchgrid-Tenant: <slug>` must be present and must
   match the token's org, else `403`. It is a consistency assertion, never a trust input: a request that
   supplies only this header and no valid token is unauthenticated.
5. `@TenantOptional` routes skip 1–4.

The reframing that matters: **the credential carries the tenant; the host is corroboration.** The
previous docs had it backwards, and that inversion was load-bearing in three files.

Unknown org → `404`. Suspended → `403`. Pending deletion → `404`. Token org ≠ asserted org → `403`.

### 2. Per-tenant cookie names

```
pg_at_<slug>   access   Domain=.patchgrid.xyz  httpOnly  SameSite=Lax  Secure  Path=/
pg_rt_<slug>   refresh  Domain=.patchgrid.xyz  httpOnly  SameSite=Lax  Secure  Path=/api/v1/auth
pg_id          identity Domain=.patchgrid.xyz  httpOnly  SameSite=Lax  Secure  Path=/
```

- `pg_at_<slug>` / `pg_rt_<slug>` are minted per organization. Two tabs on two tenants no longer
  collide, which is the property ADR-0014 claimed.
- `pg_id` is tenant-less and holds only the user identity. It is what `app.patchgrid.xyz` uses to list
  workspaces (via `UserOrgIndex`, ADR-0022) and what `apps/www` reads to swap "Get started" for "Go to
  your workspace". It grants no tenant access on its own.
- The API selects the cookie matching the tenant resolved in §1. A cookie for a different tenant is not
  a fallback; it is ignored.
- **Budget.** Browsers cap cookies per domain (~180) and headers per request. On mint, prune to the 5
  most recently used tenant cookie pairs; the picker re-mints on demand, so pruning is invisible.
- The slug is in the cookie *name*, so a slug change (ADR-0017) re-mints under the new name and expires
  the old one in the same response.

`__Host-` prefixes cannot be used: they forbid a `Domain` attribute, and `api.` must read these.

### 3. Cookie tossing is a residual risk, stated plainly

Any tenant subdomain can set cookies for `.patchgrid.xyz`. A malicious tenant can therefore overwrite
`pg_at_<victim-slug>` in a visitor's browser. It cannot *forge* one — the token is signed — so the
ceiling is denial of service (the victim is logged out) rather than takeover. Per-tenant names mean the
attack cannot silently swap which tenant a user is acting in, which is the dangerous version. Recorded
in the threat model; the structural fix is the Public Suffix List route, deferred.

### 4. CSRF

Unchanged in spirit, stated precisely: every mutating request requires `X-Requested-With: patchgrid`
(which a cross-site form cannot set, and which forces a CORS preflight the API controls) **and** an
`Origin` matching the resolved tenant when `Origin` is present. `SameSite=Lax` is defence in depth only
— subdomains are same-site and it does not separate them.

### 5. Revocation epoch

Redis key `rev:<membershipId>` → unix seconds. Every access token carries `iat` and `membershipId`; a
token with `iat < epoch` is rejected with `401` and the client refreshes, which re-reads the membership
and fails if it is gone.

The epoch is bumped on: membership disabled or removed, role changed, team membership changed,
organization suspended or pending deletion, password changed, "log out everywhere", API token revoked,
and support session revoked or expired.

One Redis `GET` on a request path that already reaches Redis for throttling. **On a Redis outage the
check fails closed for mutations and open for reads** — a deliberate availability trade, stated here so
it is not silently reversed: reads of already-authorized data are lower risk than continuing to accept
writes from a credential we cannot verify.

This also fixes staleness in `GET /me`: a promotion or demotion previously took up to 15 minutes to
appear in the UI's permission list.

## Consequences

- Login mints `pg_id` plus a tenant pair; the org picker mints additional pairs without disturbing
  existing ones. Logout from one workspace clears only that pair; "log out everywhere" clears `pg_id` and
  all pairs and bumps every epoch.
- `apiFetch` gains two responsibilities: choose the cookie for the current tenant when running
  server-side, and send `X-Patchgrid-Tenant`. Both live in the single client from ADR-0007, so no caller
  changes.
- CORS is unchanged: apex, `www`, `app`, and any host matching the slug regex, credentials on.
- `EventSource` works unchanged — it is a GET, it sends cookies and `Origin`, and it needs no custom
  header.
- The 15-minute access token survives as a performance decision rather than a security compromise,
  because the epoch bounds the damage to one Redis round trip of staleness.
- Testing: the isolation suite gains "tab A on acme and tab B on globex both keep working", which is
  exactly the scenario the `both@acme.test` seed account exists for.
